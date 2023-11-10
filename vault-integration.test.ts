import { z } from "./deps.ts";

import { assertEquals, assertRejects, delay } from "./deps_test.ts";

import { VAULT_AUTH_TYPE, VaultApproleCredentials, VaultTokenCredentials } from "./auth.ts";
import { VaultClient } from "./client.ts";
import { doVaultFetch } from "./vault.ts";
import { createKVReadResponse, createReadResponse, KVListResponse, LoginResponse, WrapResponse } from "./types.ts";

const _vaultAddr = "127.0.0.1:8200";
const vaultAddress = `http://${_vaultAddr}`;
const vaultToken = "foobarbaz123";

const hasRequiredPermissions = await (async () => {
    const spawnPermission = await Deno.permissions.request({
        name: "run",
        command: "vault",
    });

    if (spawnPermission.state !== "granted") {
        console.warn("Not allowed to spawn Vault dev server, skipping integration tests");
        return false;
    }

    const netPermission = await Deno.permissions.request({
        name: "net",
        host: _vaultAddr,
    });

    if (netPermission.state !== "granted") {
        console.warn("Not allowed to connect to Vault dev server, skipping integration tests");
        return false;
    }

    return true;
})();

// Spawn Vault dev server
let vaultAbort: AbortController | null = null;
let vaultProcess: Deno.ChildProcess | null = null;

function spawnVault() {
    if (vaultProcess !== null) {
        return;
    }
    vaultAbort = new AbortController();

    const cmd = new Deno.Command("vault", {
        args: ["server", "-dev", "-dev-no-store-token", `-dev-root-token-id=${vaultToken}`],
        env: {
            "VAULT_LOG_LEVEL": "warn",
        },
        signal: vaultAbort.signal,
        stdout: "inherit",
        stderr: "inherit",
    });

    const process = vaultProcess = cmd.spawn();
    process.output().then((result) => {
        console.log("Vault process exited", result);
    });
}

async function disposeVault() {
    if (vaultProcess && vaultAbort) {
        vaultAbort.abort("test suite end");
        await vaultProcess.output();
    }
    vaultProcess = null;
    vaultAbort = null;
}

addEventListener("unload", () => {
    disposeVault();
});

async function healthcheck(): Promise<boolean> {
    await doVaultFetch(
        z.any(),
        vaultAddress,
        undefined,
        undefined,
        "sys/health",
        { method: "GET" },
        undefined,
        vaultAbort?.signal,
    );

    return true;
}

async function createVaultClient(): Promise<{ client: VaultClient<VaultTokenCredentials>; dispose: () => Promise<void> }> {
    const authentication: VaultTokenCredentials = {
        [VAULT_AUTH_TYPE]: "token",
        mountpoint: "auth/token",
        token: vaultToken,
    };

    const client = new VaultClient({
        address: vaultAddress,
        namespace: undefined,
        authentication,
    });

    await client.login();
    return {
        client,
        async dispose() {
            await client.logout();
            await disposeVault();
        },
    };
}

async function ensureVaultReady() {
    spawnVault();

    // Ensure Vault is ready
    let i = 0;
    do {
        try {
            const ready = await healthcheck();
            if (ready) {
                return createVaultClient();
            }
        } catch (_e) {
            console.log("Vault is not ready yet, sleeping");
            await delay(1000);
            i++;
        }
    } while (i <= 5);

    throw new Error(`Vault is not ready after polling ${i} times`);
}

async function withApproleClient(mountpoint: string, roleID: string, secretID?: string): Promise<VaultClient<VaultApproleCredentials>> {
    const authentication: VaultApproleCredentials = {
        [VAULT_AUTH_TYPE]: "approle",
        mountpoint,
        roleID,
        secretID,
    };

    const client = new VaultClient({
        address: vaultAddress,
        namespace: undefined,
        authentication,
    });

    await client.login();
    return client;
}

async function withAuthMount<
    C extends Awaited<ReturnType<typeof createVaultClient>>["client"],
>(client: C, path: string, type: string, fn: (client: C) => Promise<void>) {
    try {
        await client.write(undefined, `sys/auth/${path}`, { type });

        return await fn(client);
    } finally {
        await client.write(undefined, `sys/auth/${path}`, undefined, { method: "DELETE" });
    }
}

async function withSecretMount<
    C extends Awaited<ReturnType<typeof createVaultClient>>["client"],
>(client: C, path: string, type: string, fn: (client: C) => Promise<void>) {
    try {
        await client.write(undefined, `sys/mounts/${path}`, { type });

        return await fn(client);
    } finally {
        await client.write(undefined, `sys/mounts/${path}`, undefined, { method: "DELETE" });
    }
}

Deno.test({
    name: "Issue new orphan token",
    ignore: !hasRequiredPermissions,
    async fn() {
        const { client, dispose } = await ensureVaultReady();
        const orphanToken = await client.issueToken();

        console.log("Issued new orphan token", orphanToken);
        await dispose();
    },
});

Deno.test({
    name: "Issue new response-wrapped orphan token",
    ignore: !hasRequiredPermissions,
    async fn() {
        const { client, dispose } = await ensureVaultReady();

        const wrappedOrphanToken = await client.write(WrapResponse, "auth/token/create", {
            renewable: true,
            period: 300,
        }, {
            wrapTTL: 30,
        });

        const { auth: { client_token } } = await client.unwrap(
            LoginResponse,
            wrappedOrphanToken.wrap_info.token,
            "auth/token/create",
        );

        console.log("Unwrapped auth token", client_token);

        await dispose();
    },
});

Deno.test({
    name: "KV 1 engine read & write & list",
    ignore: !hasRequiredPermissions,
    async fn() {
        const { client, dispose } = await ensureVaultReady();

        await withSecretMount(client, "kv", "kv", async (client) => {
            const date = new Date().toISOString();
            const count = 5;

            const secretStructure = z.object({
                value: z.string(),
                date: z.string(),
            });

            // Write a few secrets
            for (let i = 0; i < count; i++) {
                await client.write(undefined, `kv/secret/testing/${i}`, {
                    value: `bar${i}`,
                    date,
                });
            }

            // List secrets
            const { data: { keys: secrets } } = await client.read(KVListResponse, "kv/secret/testing", { method: "LIST" });
            assertEquals(secrets.length, count);

            // Read secrets
            for (let i = 0; i < count; i++) {
                const { data: secret } = await client.read(createReadResponse(secretStructure), `kv/secret/testing/${i}`);
                assertEquals(secret.value, `bar${i}`);
                assertEquals(secret.date, date);
            }
        });

        await dispose();
    },
});

Deno.test({
    name: "KV 2 engine read & write & list",
    ignore: !hasRequiredPermissions,
    async fn() {
        const { client, dispose } = await ensureVaultReady();

        await withSecretMount(client, "kv", "kv-v2", async (client) => {
            const date = new Date().toISOString();
            const count = 5;

            const secretStructure = z.object({
                value: z.string(),
                date: z.string(),
            });

            // Write a few secrets
            for (let i = 0; i < count; i++) {
                await client.write(z.any(), `kv/data/testing/${i}`, {
                    data: {
                        value: `bar${i}`,
                        date,
                    },
                });
            }

            // List secrets
            const { data: { keys: secrets } } = await client.read(KVListResponse, "kv/metadata/testing", { method: "LIST" });
            assertEquals(secrets.length, count);

            // Read secrets
            for (let i = 0; i < count; i++) {
                const { data: { data: secret } } = await client.read(createKVReadResponse(secretStructure), `kv/data/testing/${i}`);
                assertEquals(secret.value, `bar${i}`);
                assertEquals(secret.date, date);
            }
        });

        await dispose();
    },
});

Deno.test({
    name: "AppRole authentication",
    ignore: !hasRequiredPermissions,
    async fn() {
        const { client: rootClient, dispose } = await ensureVaultReady();

        await withAuthMount(rootClient, "approle", "approle", async (rootClient) => {
            const roleName = "integtest";

            // Create approle
            await rootClient.write(undefined, `auth/approle/role/${roleName}`, {
                bind_secret_id: true,
                secret_id_num_uses: 2,
                token_max_ttl: "1h",
                token_type: "batch",
            });

            // Obtain approle credentials
            const { data: { role_id: roleId } } = await rootClient.read(
                createReadResponse(
                    z.object({ role_id: z.string() }),
                ),
                `auth/approle/role/${roleName}/role-id`,
            );
            const { data: { secret_id: secretId } } = await rootClient.write(
                createReadResponse(
                    z.object({ secret_id: z.string() }),
                ),
                `auth/approle/role/${roleName}/secret-id`,
                {},
            );

            // Use approle client
            const client = await withApproleClient("auth/approle", roleId, secretId);
            try {
                console.log("AppRole lookup", client.token, await client.lookup());
            } finally {
                await client.logout();
            }
        });

        await dispose();
    },
});

Deno.test({
    name: "Aborted request",
    ignore: !hasRequiredPermissions,
    async fn() {
        const { client, dispose } = await ensureVaultReady();

        const abortController = new AbortController();
        const { signal } = abortController;

        const msg = "aborted for unit testing purposes";
        abortController.abort(msg);

        await assertRejects(async () => {
            await client.login({ signal });
        }, msg);

        await assertRejects(async () => {
            await client.approleLogin({ signal });
        }, msg);

        await assertRejects(async () => {
            await client.lookup(undefined, { signal });
        }, msg);

        await assertRejects(async () => {
            await client.renewToken(undefined, { signal });
        }, msg);

        await assertRejects(async () => {
            await client.issueToken(undefined, { signal });
        }, msg);

        await assertRejects(async () => {
            await client.read(z.any(), "sys/health", { signal });
        }, msg);

        await assertRejects(async () => {
            await client.write(z.any(), "dummy", undefined, { signal });
        }, msg);

        await assertRejects(async () => {
            await client.unwrap(z.any(), "dummy", undefined, { signal });
        }, msg);

        await dispose();
    },
});
