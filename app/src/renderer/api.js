// Thin wrapper around the preload bridge. Every call returns the handler's
// value or throws an ApiError carrying the main process's error code.
const bridge = window.authorStudio;

export class ApiError extends Error {
  constructor({ code = 'internal', message = 'Something went wrong.', details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}

export async function call(channel, payload) {
  let result;
  try {
    result = await bridge.call(channel, payload);
  } catch (error) {
    throw new ApiError({ code: 'internal', message: `Author Studio could not complete that request. ${error?.message ?? ''}`.trim() });
  }
  if (result?.ok) return result.value;
  throw new ApiError(result?.error);
}

export const onEngineEvent = (callback) => bridge.onEngineEvent(callback);
export const onMenuCommand = (callback) => bridge.onMenuCommand(callback);
export const platform = bridge.platform;
