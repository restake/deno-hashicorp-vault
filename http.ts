import { z } from "./deps.ts";
import type { ZodType } from "./deps.ts";

export async function fetchJSONOnlyOk<T = unknown>(response: Response): Promise<T> {
    if (!response.ok) {
        const body = await response.json();
        throw new HTTPError(response.status, body);
    }
    return response.json() as Promise<T>;
}

export function fetchJSONZod<T extends ZodType, R extends z.output<T>>(validator: T): (response: Response) => Promise<R> {
    return (response) =>
        fetchJSONOnlyOk<unknown>(response)
            .then((body) => validator.parseAsync(body));
}

export class HTTPError extends Error {
    readonly name = "HTTPError";
    readonly status: number;
    readonly body: unknown;

    // deno-lint-ignore no-explicit-any
    constructor(status: number, body: unknown, ...params: any[]) {
        super(...params);
        this.status = status;
        this.body = body;
    }

    get message(): string {
        const body = JSON.stringify(this.body);
        return `Server responded with code ${this.status}: ${body}`;
    }
}
