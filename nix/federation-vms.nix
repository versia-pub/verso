# Two Verso instances on their own machines, a.test and b.test, federating over real TLS: a user
# on b.test looks up alice@a.test, so b.test finds her with WebFinger and fetches her, signed.
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
in
pkgs.testers.runNixOSTest {
  name = "federation-vms";
  nodes.a = instance "a.test";
  nodes.b = instance "b.test";
  testScript = ''
    import base64
    import hashlib
    import json

    def sql(machine, statement):
        return machine.succeed(f"sudo -u postgres psql -d verso -tAc {json.dumps(statement)}")

    start_all()
    for machine in [a, b]:
        machine.wait_for_unit("verso.service")
        machine.wait_for_open_port(8080)
        machine.wait_for_unit("nginx.service")
        machine.wait_for_open_port(443)

    sql(a, "insert into accounts (id, username, created_at) values ('alice', 'alice', now())")

    # A user on b.test, with a token, hashed as Verso hashes them.
    token = "federation-vms-token"
    token_hash = base64.urlsafe_b64encode(hashlib.sha256(token.encode()).digest()).rstrip(b"=").decode()
    sql(b, "insert into accounts (id, username, created_at) values ('bea', 'bea', now())")
    sql(b, "insert into apps (id, name, redirect_uris, scopes, client_id, client_secret_hash, created_at) "
        "values ('app', 'Test', '[]', '[\"read\"]', 'client', 'unused', now())")
    sql(b, "insert into access_tokens (id, token_hash, app_id, account_id, scopes, created_at) "
        f"values ('token', '{token_hash}', 'app', 'bea', '[\"read\"]', now())")

    found = json.loads(b.succeed(
        "curl --fail --silent https://b.test/api/v1/accounts/lookup?acct=alice@a.test "
        f"--header 'authorization: Bearer {token}'"
    ))
    assert found["acct"] == "alice@a.test", f"b.test found {found!r}"
    assert found["uri"] == "https://a.test/.versia/v0.6/entities/User/alice", found["uri"]

    kept = sql(b, "select a.username, i.domain from accounts a join instances i on i.id = a.instance_id")
    assert kept.strip() == "alice|a.test", f"b.test kept {kept!r}"
  '';
}
