import { z } from "./deps.ts";
import type { ZodType } from "./deps.ts";

import { fetchJSONZod } from "./http.ts";

export async function doVaultFetch<T extends ZodType, R extends z.output<T>>(
    validator: T,
    vaultAddr: string | URL,
    vaultNamespace: string | undefined,
    vaultToken: string | undefined,
    endpoint: string,
    opts?: RequestInit,
    body?: unknown,
): Promise<R> {
    const url = new URL(`/v1/${endpoint}`, vaultAddr);
    const headers: Headers = new Headers(opts?.headers);

    if (vaultNamespace) {
        headers.append("X-Vault-Namespace", `${vaultNamespace}/`);
    }

    if (vaultToken) {
        headers.append("X-Vault-Token", vaultToken);
    }

    if (body && (opts?.method ?? "GET") !== "GET") {
        headers.append("Content-type", "application/json");
    }

    const request = fetch(url, {
        ...opts,
        headers,
        body: (!opts?.body && body && (opts?.method ?? "GET") !== "GET") ? JSON.stringify(body) : opts?.body,
    });

    return await request.then(fetchJSONZod(validator));
}
