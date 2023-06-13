import { VAULT_AUTH_TYPE, VaultApproleCredentials, VaultAuthentication, VaultCredentials, VaultTokenCredentials } from "./auth.ts";
import { LoginResponse, TokenLookupResponse } from "./types.ts";
import { doVaultFetch } from "./vault.ts";

import { ZodType } from "zod";

export class VaultClient<T extends VaultAuthentication> {
    private credentials: VaultCredentials<T>;
    private currentToken: string | undefined;
    private currentTokenAccessor: string | undefined;
    private renewTimerHandle: number | undefined;

    constructor(credentials: VaultCredentials<T>) {
        this.credentials = credentials;
    }

    async login(): Promise<void> {
        const authType = this.credentials.authentication[VAULT_AUTH_TYPE];

        let leaseDuration = 0;
        let isRenewable = false;

        switch (authType) {
            case "approle": {
                const { client_token, accessor, lease_duration, renewable } = await this.approleLogin();
                this.currentToken = client_token;
                this.currentTokenAccessor = accessor;

                leaseDuration = lease_duration;
                isRenewable = renewable;
                break;
            }
            case "token": {
                const tokenCredentials = this.credentials.authentication as unknown as VaultTokenCredentials;
                this.currentToken = tokenCredentials.token;

                const { data: { accessor, renewable, ttl } } = await this.lookup();
                this.currentTokenAccessor = accessor;

                leaseDuration = ttl;
                isRenewable = renewable;
                break;
            }
            default: {
                throw new Error(`Unsupported authentication type "${authType}"`);
            }
        }

        if (isRenewable && leaseDuration > 0) {
            this.createRenewTimer(leaseDuration);
        }
    }

    // deno-lint-ignore require-await
    async logout(): Promise<void> {
        if (this.renewTimerHandle) {
            clearTimeout(this.renewTimerHandle);
        }
    }

    async approleLogin(): Promise<{ client_token: string; accessor: string; lease_duration: number; renewable: boolean }> {
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
        });

        return {
            client_token: res.auth.client_token,
            accessor: res.auth.accessor,
            lease_duration: res.auth.lease_duration,
            renewable: res.auth.renewable,
        };
    }

    async lookup(accessor?: string): Promise<TokenLookupResponse> {
        const { address, namespace } = this.credentials;
        const res = await doVaultFetch(
            TokenLookupResponse,
            address,
            namespace,
            this.currentToken,
            `auth/token/lookup` + (accessor ? "-accessor" : "-self"),
            { method: accessor ? "POST" : "GET" },
            accessor ? { accessor } : undefined,
        );

        return res;
    }

    async renewToken(accessor?: string): Promise<{ accessor: string; lease_duration: number }> {
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
        );

        return {
            accessor: res.auth.accessor,
            lease_duration: res.auth.lease_duration,
        };
    }

    async issueToken(
        role?: string,
    ): Promise<{ client_token: string; accessor: string; lease_duration: number }> {
        this.assertToken();

        const { address, namespace } = this.credentials;

        const endpoint = `auth/token/create` + (role ? `/${role}` : "");
        const res = await doVaultFetch(LoginResponse, address, namespace, this.currentToken, endpoint, {
            method: "POST",
        });

        return {
            client_token: res.auth.client_token,
            accessor: res.auth.accessor,
            lease_duration: res.auth.lease_duration,
        };
    }

    async read<T extends ZodType>(type: T, endpoint: string): Promise<T> {
        const { address, namespace } = this.credentials;

        return await doVaultFetch(
            type,
            address,
            namespace,
            this.currentToken,
            endpoint,
            { method: "GET" },
        );
    }

    async write<T extends ZodType>(type: T, endpoint: string, body: unknown): Promise<T> {
        const { address, namespace } = this.credentials;

        return await doVaultFetch(
            type,
            address,
            namespace,
            this.currentToken,
            endpoint,
            { method: "POST" },
            body,
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
        return (leaseDuration - buffer) * 1000;
    }

    private async renewTimer(): Promise<{ lease_duration: number }> {
        const { accessor, lease_duration } = await this.renewToken();
        this.currentTokenAccessor = accessor;
        return { lease_duration };
    }

    private createRenewTimer(leaseDuration: number) {
        const timeout = this.renewInterval(leaseDuration);
        this.renewTimerHandle = setTimeout(() => {
            this.renewTimer().then(({ lease_duration }) => {
                this.createRenewTimer(lease_duration);
            });
        }, timeout);
    }
}
