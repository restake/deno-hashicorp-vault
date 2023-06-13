import { z, ZodType } from "zod";

export const ErrorResponse = z.object({
    errors: z.array(z.string()),
});

export type ErrorResponse = z.infer<typeof ErrorResponse>;

export const AuthData = z.object({
    client_token: z.string(),
    accessor: z.string(),
    policies: z.array(z.string()),
    token_policies: z.array(z.string()),
    lease_duration: z.number(),
    renewable: z.boolean(),
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
}));

export type TokenLookupResponse = z.infer<typeof TokenLookupResponse>;

export function createGenericResponse<T extends ZodType>(response: T) {
    return z.object({
        data: response,
    });
}

export type GenericResponse<T extends ZodType> = z.infer<ReturnType<typeof createGenericResponse<T>>>;

export function createReadResponse<T extends ZodType>(response: T) {
    return z.object({
        request_id: z.string(),
        lease_id: z.string(),
        renewable: z.boolean(),
        lease_duration: z.number(),
        data: response,
        warnings: z.array(z.string()),
    });
}

export type ReadResponse<T extends ZodType> = z.infer<ReturnType<typeof createReadResponse<T>>>;
