import { z } from "zod";
import {
    ExtendedDescription,
    Instance,
    PrivacyPolicy,
    Rule,
    TermsOfService,
    V1Instance,
} from "../instance.ts";
import { type CallOptions, type Http, path } from "./http.ts";

/** What the instance says about itself. Anyone may ask. */
export class InstanceMethods {
    constructor(private readonly http: Http) {}

    /**
     * The instance, its limits, and how to join and contact it.
     * @see https://docs.joinmastodon.org/methods/instance/#v2
     */
    get(options?: CallOptions): Promise<Instance> {
        return this.http.json(Instance, "GET", "/api/v2/instance", options);
    }

    /**
     * The instance, as Mastodon described it before 4.0, for apps that read only that.
     * @see https://docs.joinmastodon.org/methods/instance/#v1
     */
    getV1(options?: CallOptions): Promise<V1Instance> {
        return this.http.json(V1Instance, "GET", "/api/v1/instance", options);
    }

    /**
     * What people agree to follow on the instance.
     * @see https://docs.joinmastodon.org/methods/instance/#rules
     */
    rules(options?: CallOptions): Promise<Rule[]> {
        return this.http.json(z.array(Rule), "GET", "/api/v1/instance/rules", options);
    }

    /**
     * A longer text about the instance, for its about page.
     * @see https://docs.joinmastodon.org/methods/instance/#extended_description
     */
    extendedDescription(options?: CallOptions): Promise<ExtendedDescription> {
        return this.http.json(
            ExtendedDescription,
            "GET",
            "/api/v1/instance/extended_description",
            options,
        );
    }

    /**
     * The instance's privacy policy.
     * @see https://docs.joinmastodon.org/methods/instance/#privacy_policy
     */
    privacyPolicy(options?: CallOptions): Promise<PrivacyPolicy> {
        return this.http.json(PrivacyPolicy, "GET", "/api/v1/instance/privacy_policy", options);
    }

    /**
     * The instance's terms of service: those in force now, or from `date`, as `YYYY-MM-DD`.
     * @see https://docs.joinmastodon.org/methods/instance/#terms_of_service
     */
    termsOfService(date?: string, options?: CallOptions): Promise<TermsOfService> {
        return this.http.json(
            TermsOfService,
            "GET",
            date === undefined
                ? "/api/v1/instance/terms_of_service"
                : path`/api/v1/instance/terms_of_service/${date}`,
            options,
        );
    }
}
