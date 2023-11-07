import { z, ZodType } from "./deps.ts";

import { VAULT_AUTH_TYPE, VaultApproleCredentials, VaultAuthentication, VaultCredentials, VaultTokenCredentials } from "./auth.ts";
import { HTTPError } from "./http.ts";
import { createGenericResponse, LoginResponse, TokenLookupResponse } from "./types.ts";
import { doVaultFetch } from "./vault.ts";

export type VaultRequestOptions = {
    method?: string;
    wrapTTL?: number | string;
    signal?: AbortSignal;
};

export class VaultClient<T extends VaultAuthentication> {
    private credentials: VaultCredentials<T>;
    private currentToken: string | undefined;
    private currentTokenAccessor: string | undefined;
    private currentLeaseDuration = 0;
    private renewTimerHandle: number | undefined;

    constructor(credentials: VaultCredentials<T>) {
        this.credentials = credentials;
    }

    get token(): string {
        this.assertToken();
        return this.currentToken!;
    }

    get accessor(): string {
        this.assertToken();
        return this.currentTokenAccessor!;
    }

    async login(opts?: Pick<VaultRequestOptions, "signal">): Promise<void> {
        const authType = this.credentials.authentication[VAULT_AUTH_TYPE];

        this.currentLeaseDuration = 0;
        let isRenewable = false;

        switch (authType) {
            case "approle": {
                const { client_token, accessor, lease_duration, renewable } = await this.approleLogin(opts);
                this.currentToken = client_token;
                this.currentTokenAccessor = accessor;

                this.currentLeaseDuration = lease_duration;
                isRenewable = renewable && accessor !== "";
                break;
            }
            case "token": {
                const tokenCredentials = this.credentials.authentication as unknown as VaultTokenCredentials;
                this.currentToken = tokenCredentials.token;

                const { data: { accessor, renewable, ttl } } = await this.lookup(undefined, opts);
                this.currentTokenAccessor = accessor;

                this.currentLeaseDuration = ttl;
                isRenewable = renewable && accessor !== "";
                break;
            }
            default: {
                throw new Error(`Unsupported authentication type "${authType}"`);
            }
        }

        if (isRenewable && this.currentLeaseDuration > 0) {
            this.createRenewTimer(this.currentLeaseDuration);
        }
    }

    // deno-lint-ignore require-await
    async logout(): Promise<void> {
        if (this.renewTimerHandle) {
            clearTimeout(this.renewTimerHandle);
        }
    }

    async approleLogin(
        opts?: Pick<VaultRequestOptions, "signal">,
    ): Promise<{ client_token: string; accessor: string; lease_duration: number; renewable: boolean }> {
        const authType = this.credentials.authentication[VAULT_AUTH_TYPE];
        if (authType !== "approle") {
            throw new Error(`approleLogin cannot be used with authentication type "${authType}"`);
        }

        const { address, namespace } = this.credentials;
        const authentication = this.credentials.authentication as unknown as VaultApproleCredentials;
        const { mountpoint, roleID, secretID } = authentication;

        const res = await doVaultFetch(LoginResponse, address, namespace, undefined, `${mountpoint}/login`, { method: "POST" }, {
            role_id: roleID,
            secret_id: secretID,
        }, opts?.signal);

        return {
            client_token: res.auth.client_token,
            accessor: res.auth.accessor,
            lease_duration: res.auth.lease_duration,
            renewable: res.auth.renewable,
        };
    }

    async lookup(
        accessor?: string,
        opts?: Pick<VaultRequestOptions, "signal">,
    ): Promise<TokenLookupResponse> {
        this.assertToken();

        const { address, namespace } = this.credentials;
        const res = await doVaultFetch(
            TokenLookupResponse,
            address,
            namespace,
            this.currentToken,
            `auth/token/lookup` + (accessor ? "-accessor" : "-self"),
            { method: accessor ? "POST" : "GET" },
            accessor ? { accessor } : undefined,
            opts?.signal,
        );

        return res;
    }

    async renewToken(
        accessor?: string,
        opts?: Pick<VaultRequestOptions, "signal">,
    ): Promise<{ accessor: string; lease_duration: number }> {
        this.assertToken();

        const { address, namespace } = this.credentials;

        const res = await doVaultFetch(
            LoginResponse,
            address,
            namespace,
            this.currentToken,
            "auth/token/renew" + (accessor ? "-accessor" : "-self"),
            { method: "POST" },
            accessor ? { accessor } : undefined,
            opts?.signal,
        );

        return {
            accessor: res.auth.accessor,
            lease_duration: res.auth.lease_duration,
        };
    }

    async issueToken(
        role?: string,
        opts?: Pick<VaultRequestOptions, "signal">,
    ): Promise<{ client_token: string; accessor: string; lease_duration: number }> {
        this.assertToken();

        const { address, namespace } = this.credentials;

        const endpoint = `auth/token/create` + (role ? `/${role}` : "");
        const res = await doVaultFetch(
            LoginResponse,
            address,
            namespace,
            this.currentToken,
            endpoint,
            {
                method: "POST",
            },
            undefined,
            opts?.signal,
        );

        return {
            client_token: res.auth.client_token,
            accessor: res.auth.accessor,
            lease_duration: res.auth.lease_duration,
        };
    }

    async read<
        T extends ZodType,
        R = z.output<T>,
    >(
        type: T,
        endpoint: string,
        opts?: VaultRequestOptions,
    ): Promise<R> {
        this.assertToken();

        const { address, namespace } = this.credentials;

        return await doVaultFetch(
            type,
            address,
            namespace,
            this.currentToken,
            endpoint,
            {
                method: opts?.method ?? "GET",
                headers: {
                    ...(opts?.wrapTTL && { "x-vault-wrap-ttl": `${opts.wrapTTL}` }),
                },
            },
            undefined,
            opts?.signal,
        );
    }

    async write<
        T extends ZodType | undefined,
        R extends (T extends ZodType ? z.output<T> : undefined),
    >(
        type: T,
        endpoint: string,
        body: unknown,
        opts?: VaultRequestOptions,
    ): Promise<R> {
        this.assertToken();

        const { address, namespace } = this.credentials;

        return await doVaultFetch(
            type,
            address,
            namespace,
            this.currentToken,
            endpoint,
            {
                method: opts?.method ?? "POST",
                headers: {
                    ...(opts?.wrapTTL && { "x-vault-wrap-ttl": `${opts.wrapTTL}` }),
                },
            },
            body,
            opts?.signal,
        );
    }

    async unwrap<
        T extends ZodType,
        R = z.output<T>,
    >(
        type: T,
        wrappingToken: string,
        expectedCreationPath?: string,
        opts?: Pick<VaultRequestOptions, "signal">,
    ): Promise<R> {
        const { address, namespace } = this.credentials;

        // Check creation path, if specified
        if (expectedCreationPath) {
            const { data: creationData } = await doVaultFetch(
                createGenericResponse(z.object({ creation_path: z.string() })),
                address,
                namespace,
                wrappingToken,
                "sys/wrapping/lookup",
                {
                    method: "POST",
                },
                {
                    token: wrappingToken,
                },
                opts?.signal,
            );

            if (expectedCreationPath !== creationData.creation_path) {
                throw new Error(`Expected creation path '${expectedCreationPath}', got '${creationData.creation_path}'`);
            }
        }

        return await doVaultFetch(
            type,
            address,
            namespace,
            wrappingToken,
            "sys/wrapping/unwrap",
            {
                method: "POST",
            },
            undefined,
            opts?.signal,
        );
    }

    private assertToken() {
        if (!this.currentToken) {
            throw new Error("No valid token available");
        }
    }

    // Returns renew interval in milliseconds minus buffer
    private renewInterval(leaseDuration: number): number {
        const buffer = Math.ceil(leaseDuration / 5);
        const desired = Math.max(leaseDuration - buffer, 1) * 1000;
        return Math.min(desired, 2_147_483_647);
    }

    private async renewTimer(): Promise<{ lease_duration: number }> {
        try {
            const { accessor, lease_duration } = await this.renewToken();
            this.currentTokenAccessor = accessor;
            return { lease_duration };
        } catch (e) {
            if (e instanceof HTTPError) {
                if (e.status === 403) {
                    // We got "permission denied", rethrow
                    throw e;
                }
            }
            console.error("[vault] Failed to renew lease, retrying next cycle", e);
            return { lease_duration: this.currentLeaseDuration };
        }
    }

    private createRenewTimer(leaseDuration: number) {
        const timeout = this.renewInterval(leaseDuration);
        const handle = this.renewTimerHandle = setTimeout(() => {
            this.renewTimer().then(({ lease_duration }) => {
                this.createRenewTimer(lease_duration);
            }).catch((e) => {
                console.error("[vault] Failed to renew lease, canceling renewal timer", e);
            });
        }, timeout);

        Deno.unrefTimer(handle);
    }
}
