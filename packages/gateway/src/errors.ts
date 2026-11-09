// OpenAI-shaped error body, used for every error the gateway itself produces.
export const errorBody = (message: string, type: string, code?: string) => ({
  error: { message, type, ...(code ? { code } : {}) },
});
