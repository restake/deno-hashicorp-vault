import { z, ZodType } from "./deps.ts";

import { VAULT_AUTH_TYPE, VaultApproleCredentials, VaultAuthentication, VaultCredentials, VaultTokenCredentials } from "./auth.ts";
import { HTTPError } from "./http.ts";
import { createGenericResponse, LoginResponse, TokenLookupResponse, TokenType } from "./types.ts";
import { doVaultFetch } from "./vault.ts";

export type VaultRequestOptions = {
    method?: string;
    wrapTTL?: number | string;
    signal?: AbortSignal;
};

export type VaultTokenInfo = {
    token: string;
    accessor?: string;
};

export type VaultClientOptions = {
    enableRenewalTimer: boolean;
};

export class VaultClient<T extends VaultAuthentication> {
    private options: VaultCredentials<T> & Partial<VaultClientOptions>;
    private currentToken: string | undefined;
    private currentTokenAccessor: string | undefined;
    private currentLeaseDuration = 0;
    private renewTimerHandle: number | undefined;
    private canRevoke = true;

    constructor(options: VaultCredentials<T> & Partial<VaultClientOptions>) {
        this.options = options;
    }

    get token(): string {
        return this.tokenInfo.token;
    }

    get accessor(): string | undefined {
        return this.tokenInfo.accessor;
    }

    get tokenInfo(): VaultTokenInfo {
        const token = this.currentToken;
        const accessor = this.currentTokenAccessor;

        if (token === undefined) {
            throw new Error("No valid token available");
        }

        return {
            token,
            accessor,
        };
    }

    async login(opts?: Pick<VaultRequestOptions, "signal">): Promise<void> {
        const authType = this.options.authentication[VAULT_AUTH_TYPE];

        this.currentLeaseDuration = 0;
        let isRenewable = false;

        switch (authType) {
            case "approle": {
                const { client_token, accessor, lease_duration, renewable, type } = await this.approleLogin(opts);
                this.currentToken = client_token;
                this.currentTokenAccessor = accessor;
                this.canRevoke = type === "service";

                this.currentLeaseDuration = lease_duration;
                isRenewable = renewable && !!accessor;
                break;
            }
            case "token": {
                const tokenCredentials = this.options.authentication as unknown as VaultTokenCredentials;
                this.currentToken = tokenCredentials.token;

                const { data: { accessor, renewable, ttl, type } } = await this.lookup(undefined, opts);
                this.currentTokenAccessor = accessor;
                this.canRevoke = type === "service";

                this.currentLeaseDuration = ttl;
                isRenewable = renewable && !!accessor;
                break;
            }
            default: {
                throw new Error(`Unsupported authentication type "${authType}"`);
            }
        }

        if (isRenewable && this.currentLeaseDuration > 0 && this.options.enableRenewalTimer !== false) {
            this.createRenewTimer(this.currentLeaseDuration);
        }
    }

    async logout(
        opts?: Pick<VaultRequestOptions, "signal"> & { revokeHardFail?: boolean },
    ): Promise<void> {
        if (this.renewTimerHandle) {
            clearTimeout(this.renewTimerHandle);
        }

        if (this.options.authentication.logoutRevoke && this.canRevoke) {
            await this.write(
                undefined,
                "auth/token/revoke-self",
                undefined,
                opts,
            ).catch((err) => {
                if (opts?.revokeHardFail) {
                    throw err;
                }

                console.error("[vault] Failed revoke self token", err);
            });
        }
    }

    async approleLogin(
        opts?: Pick<VaultRequestOptions, "signal">,
    ): Promise<{ client_token: string; accessor: string; lease_duration: number; renewable: boolean; type: TokenType }> {
        const authType = this.options.authentication[VAULT_AUTH_TYPE];
        if (authType !== "approle") {
            throw new Error(`approleLogin cannot be used with authentication type "${authType}"`);
        }

        const { address, namespace } = this.options;
        const authentication = this.options.authentication as unknown as VaultApproleCredentials;
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
            type: res.auth.token_type,
        };
    }

    async lookup(
        accessor?: string,
        opts?: Pick<VaultRequestOptions, "signal">,
    ): Promise<TokenLookupResponse> {
        // This is called inside login(), where we might not have accessor available
        // So check only for token presence
        const token = this.currentToken;
        if (token === undefined) {
            throw new Error("No valid token available");
        }

        const { address, namespace } = this.options;
        const res = await doVaultFetch(
            TokenLookupResponse,
            address,
            namespace,
            token,
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
        const { token } = this.tokenInfo;
        const { address, namespace } = this.options;

        const res = await doVaultFetch(
            LoginResponse,
            address,
            namespace,
            token,
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
        const { token } = this.tokenInfo;
        const { address, namespace } = this.options;

        const endpoint = `auth/token/create` + (role ? `/${role}` : "");
        const res = await doVaultFetch(
            LoginResponse,
            address,
            namespace,
            token,
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
        const { token } = this.tokenInfo;
        const { address, namespace } = this.options;

        return await doVaultFetch(
            type,
            address,
            namespace,
            token,
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
        const { token } = this.tokenInfo;
        const { address, namespace } = this.options;

        return await doVaultFetch(
            type,
            address,
            namespace,
            token,
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
        const { address, namespace } = this.options;

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

    async [Symbol.asyncDispose](): Promise<void> {
        return await this.logout();
    }
}
