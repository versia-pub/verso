# Two Verso instances on their own machines, a.test and b.test, federating over real TLS: bea on
# b.test looks up alice@a.test, so b.test finds her with WebFinger and fetches her, signed. Then bea
# follows alice, and alice's next note reaches bea's home timeline, with its totals fetched from
# a.test. bea likes and shares it, and a.test counts both. b.test keeps its uploads in a Garage
# bucket, which it checks it can write to when it starts.
{ pkgs, module }:
let
  # A certificate authority both machines trust, and a certificate for each. Test keys only.
  certificates =
    pkgs.runCommand "federation-vms-certificates" { nativeBuildInputs = [ pkgs.openssl ]; }
      ''
        mkdir $out
        cd $out
        openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
          -subj "/CN=Verso test CA" -keyout ca.key -out ca.crt
        for domain in a.test b.test; do
          openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
            -subj "/CN=$domain" -keyout $domain.key -out $domain.csr
          openssl x509 -req -in $domain.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 \
            -extfile <(printf "subjectAltName=DNS:%s" $domain) -out $domain.crt
        done
      '';

  instance =
    domain:
    { nodes, ... }:
    {
      imports = [ module ];

      services.verso = {
        enable = true;
        settings = {
          inherit domain;
          # The machines are on a private network, which Verso refuses to reach in production.
          mode = "development";
          federation.allow_internal_addresses = true;
        };
      };
      # Deno trusts its own list of authorities, not the system's.
      systemd.services.verso.environment.DENO_CERT = "${certificates}/ca.crt";

      services.nginx = {
        enable = true;
        recommendedProxySettings = true;
        virtualHosts.${domain} = {
          onlySSL = true;
          sslCertificate = "${certificates}/${domain}.crt";
          sslCertificateKey = "${certificates}/${domain}.key";
          locations."/".proxyPass = "http://127.0.0.1:8080";
        };
      };

      security.pki.certificateFiles = [ "${certificates}/ca.crt" ];
      networking.firewall.allowedTCPPorts = [ 443 ];
      networking.extraHosts = ''
        ${nodes.a.networking.primaryIPAddress} a.test
        ${nodes.b.networking.primaryIPAddress} b.test
      '';
      environment.systemPackages = [ pkgs.curl ];
    };
  # A Garage key for b.test, made up for the test, which Garage is given rather than making one.
  s3Key = {
    id = "GK0123456789abcdef01234567";
    secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  };

  # Garage on b.test, with a bucket Verso keeps its uploads in, under a prefix, which Garage also
  # serves as a website, at the bucket's public URL.
  bucket =
    { config, ... }:
    {
      services.garage = {
        enable = true;
        package = pkgs.garage;
        settings = {
          replication_factor = 1;
          rpc_bind_addr = "127.0.0.1:3901";
          rpc_secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
          s3_api = {
            api_bind_addr = "127.0.0.1:3900";
            s3_region = "garage";
          };
          s3_web = {
            bind_addr = "127.0.0.1:3902";
            root_domain = ".web.garage";
          };
        };
      };

      # A new Garage has no storage, keys or buckets until it is told to.
      systemd.services.garage-bucket = {
        after = [ "garage.service" ];
        requires = [ "garage.service" ];
        before = [ "verso.service" ];
        requiredBy = [ "verso.service" ];
        path = [ config.services.garage.package ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
        };
        script = ''
          until garage status >/dev/null 2>&1; do sleep 1; done
          garage layout assign -z test -c 1G "$(garage node id --quiet | cut -d@ -f1)"
          garage layout apply --version 1
          garage key import --yes -n verso ${s3Key.id} ${s3Key.secret}
          garage bucket create media
          garage bucket allow --read --write media --key verso
          garage bucket website --allow media
        '';
      };

      services.verso = {
        settings.media.storage.s3 = {
          endpoint = "http://127.0.0.1:3900";
          region = "garage";
          bucket = "media";
          prefix = "verso/media";
          access_key_id = s3Key.id;
          secret_access_key = "\${file:/run/credentials/verso.service/s3}";
          public_url = "http://media.web.garage:3902/verso/media";
        };
        credentials.s3 = "/etc/verso-s3";
      };
      environment.etc.verso-s3.text = s3Key.secret;
      networking.hosts."127.0.0.1" = [ "media.web.garage" ];
      environment.systemPackages = [ config.services.garage.package ];
    };
in
pkgs.testers.runNixOSTest {
  name = "federation-vms";
  nodes.a = instance "a.test";
  nodes.b = {
    imports = [
      (instance "b.test")
      bucket
    ];
  };
  testScript = ''
    import base64
    import hashlib
    import json
    import shlex

    def sql(machine, statement):
        return machine.succeed(f"sudo -u postgres psql -d verso -tAc {json.dumps(statement)}")

    def user(machine, username, token):
        """Adds a user, with a token for every scope, hashed as Verso hashes them."""
        token_hash = base64.urlsafe_b64encode(hashlib.sha256(token.encode()).digest()).rstrip(b"=").decode()
        sql(machine, f"insert into accounts (id, username, created_at) values ('{username}', '{username}', now())")
        sql(machine, "insert into apps (id, name, redirect_uris, scopes, client_id, client_secret_hash, created_at) "
            "values ('app', 'Test', '[]', '[\"read\", \"write\", \"follow\"]', 'client', 'unused', now())")
        sql(machine, "insert into access_tokens (id, token_hash, app_id, account_id, scopes, created_at) "
            f"values ('token', '{token_hash}', 'app', '{username}', '[\"read\", \"write\", \"follow\"]', now())")

    def api(machine, token, method, path, body=None):
        """Calls the client API on `machine` as the owner of `token`, and returns what it answers."""
        data = f"--json {shlex.quote(json.dumps(body))}" if body is not None else ""
        return json.loads(machine.succeed(
            f"curl --fail-with-body --silent --request {method} https://{machine.name}.test{path} "
            f"--header 'authorization: Bearer {token}' {data}"
        ))

    start_all()
    for machine in [a, b]:
        machine.wait_for_unit("verso.service")
        machine.wait_for_open_port(8080)
        machine.wait_for_unit("nginx.service")
        machine.wait_for_open_port(443)

    # b.test started, so it could put an object in its bucket and remove it, signed as Garage
    # wants, and keeps nothing on its own disk.
    b.succeed("systemctl is-active garage-bucket.service")
    b.fail("test -e /var/lib/verso/media")
    a.succeed("test -d /var/lib/verso/media/tmp")

    user(a, "alice", "alice-token")
    user(b, "bea", "bea-token")

    # bea uploads a file. b.test's bucket serves it, to be saved and cached for good, and b.test
    # redirects there.
    uploaded = json.loads(b.succeed(
        "printf 'PK\\003\\004notes' > /tmp/notes.zip && "
        "curl --fail-with-body --silent https://b.test/api/v2/media "
        "--header 'authorization: Bearer bea-token' --form file=@/tmp/notes.zip"
    ))
    key = uploaded["url"].removeprefix("http://media.web.garage:3902/verso/media/")
    assert len(key) == 64, f"b.test answered {uploaded!r}"
    served = b.succeed(f"curl --fail --silent --dump-header - --output /dev/null {uploaded['url']}").lower()
    assert "content-disposition: attachment" in served, served
    assert "cache-control: public, max-age=31536000, immutable" in served, served
    redirect = b.succeed(f"curl --silent --output /dev/null --write-out '%{{redirect_url}}' https://b.test/media/{key}")
    assert redirect == uploaded["url"], f"b.test redirects to {redirect!r}"

    # b.test finds alice with WebFinger, and fetches her.
    found = api(b, "bea-token", "GET", "/api/v1/accounts/lookup?acct=alice@a.test")
    assert found["acct"] == "alice@a.test", f"b.test found {found!r}"
    assert found["uri"] == "https://a.test/.versia/v0.6/entities/User/alice", found["uri"]

    kept = sql(b, "select a.username, i.domain from accounts a join instances i on i.id = a.instance_id")
    assert kept.strip() == "alice|a.test", f"b.test kept {kept!r}"

    # bea follows alice. a.test takes the follow and accepts it, and b.test takes the accept.
    api(b, "bea-token", "POST", f"/api/v1/accounts/{found['id']}/follow")
    a.wait_until_succeeds(
        "sudo -u postgres psql -d verso -tAc \"select accepted from follows where followee_id = 'alice'\" | grep -qx t"
    )
    b.wait_until_succeeds(
        f"curl --fail --silent 'https://b.test/api/v1/accounts/relationships?id[]={found['id']}' "
        "--header 'authorization: Bearer bea-token' | grep -q '\"following\":true'"
    )

    # alice posts, and the note reaches bea's home timeline on b.test.
    posted = api(a, "alice-token", "POST", "/api/v1/statuses", {"status": "Hello from a.test", "visibility": "public"})
    b.wait_until_succeeds(
        "curl --fail --silent https://b.test/api/v1/timelines/home "
        f"--header 'authorization: Bearer bea-token' | grep -qF {shlex.quote(posted['uri'])}"
    )

    home = api(b, "bea-token", "GET", "/api/v1/timelines/home")
    assert [status["uri"] for status in home] == [posted["uri"]], f"bea's home has {home!r}"
    assert home[0]["content"] == posted["content"], f"b.test shows {home[0]['content']!r}"
    assert home[0]["account"]["acct"] == "alice@a.test", home[0]["account"]

    # b.test fetched the note's totals from a.test, over collections whose names are encoded.
    b.wait_until_succeeds(
        "sudo -u postgres psql -d verso -tAc "
        "\"select likes, shares, replies from remote_note_totals\" | grep -qx '0|0|0'"
    )

    # bea likes and shares the note, and a.test counts both.
    api(b, "bea-token", "POST", f"/api/v1/statuses/{home[0]['id']}/favourite")
    api(b, "bea-token", "POST", f"/api/v1/statuses/{home[0]['id']}/reblog")
    for listed in ["favourited_by", "reblogged_by"]:
        a.wait_until_succeeds(
            f"curl --fail --silent https://a.test/api/v1/statuses/{posted['id']}/{listed} "
            "--header 'authorization: Bearer alice-token' | grep -qF '\"acct\":\"bea@b.test\"'"
        )

    status = api(a, "alice-token", "GET", f"/api/v1/statuses/{posted['id']}")
    counts = [status["favourites_count"], status["reblogs_count"]]
    assert counts == [1, 1], f"a.test counts {counts!r}"
  '';
}
