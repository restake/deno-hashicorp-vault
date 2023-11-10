import { z } from "./deps.ts";
import type { ZodType } from "./deps.ts";

export const ErrorResponse = z.object({
    errors: z.array(z.string()),
});

export type ErrorResponse = z.infer<typeof ErrorResponse>;

export const TokenType = z.enum([
    "batch",
    "service",
]);

export type TokenType = z.infer<typeof TokenType>;

export const AuthData = z.object({
    client_token: z.string(),
    accessor: z.string(),
    policies: z.array(z.string()),
    token_policies: z.array(z.string()),
    lease_duration: z.number(),
    renewable: z.boolean(),
    token_type: TokenType,
});

export type AuthData = z.infer<typeof AuthData>;

export const LoginResponse = z.object({
    auth: AuthData,
});

export type LoginResponse = z.infer<typeof AuthData>;

export const TokenLookupResponse = createGenericResponse(z.object({
    accessor: z.string(),
    renewable: z.boolean(),
    ttl: z.number(),
    type: TokenType,
}));

export type TokenLookupResponse = z.infer<typeof TokenLookupResponse>;

export function createGenericResponse<T extends ZodType>(response: T) {
    return z.object({
        data: response,
    });
}

export type GenericResponse<T extends ZodType> = z.infer<ReturnType<typeof createGenericResponse<T>>>;

export const WrapInfo = z.object({
    token: z.string(),
    accessor: z.string(),
    ttl: z.number(),
    creation_time: z.string(),
    creation_path: z.string(),
    wrapped_accessor: z.string(),
});

export type WrapInfo = z.infer<typeof WrapInfo>;

export const WrapResponse = z.object({
    wrap_info: WrapInfo,
});

export type WrapResponse = z.infer<typeof WrapResponse>;

export function createReadResponse<T extends ZodType>(response: T) {
    return z.object({
        request_id: z.string(),
        lease_id: z.string(),
        renewable: z.boolean(),
        lease_duration: z.number(),
        data: response,
        wrap_info: z.nullable(WrapInfo),
        warnings: z.array(z.string()).nullish(),
    });
}

export type ReadResponse<T extends ZodType> = z.infer<ReturnType<typeof createReadResponse<T>>>;

export function createKVReadResponse<T extends ZodType>(response: T) {
    return createReadResponse(z.object({
        data: response,
    }));
}

export type KVReadResponse<T extends ZodType> = z.infer<ReturnType<typeof createKVReadResponse<T>>>;

export const KVListResponse = createReadResponse(z.object({ keys: z.array(z.string()) }));

export type KVListResponse = z.infer<typeof KVListResponse>;
