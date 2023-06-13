export const VAULT_AUTH_TYPE = Symbol.for("restake.vault.auth");

export type VaultAuthentication = {
    [VAULT_AUTH_TYPE]: string;
    mountpoint: string;
};

export type VaultCredentials<T extends VaultAuthentication = VaultAuthentication> = {
    address: string | URL;
    namespace?: string;
    authentication: T;
};

export type VaultTokenCredentials = VaultAuthentication & {
    [VAULT_AUTH_TYPE]: "token";
    mountpoint: "auth/token";
    token: string;
};

export type VaultApproleCredentials = VaultAuthentication & {
    [VAULT_AUTH_TYPE]: "approle";
    roleID: string;
    secretID?: string;
};
