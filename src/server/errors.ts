export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public params?: Record<string, string | number>) { super(message); }
}
export function notFound(message = '记录不存在'): never { throw new AppError(404, 'NOT_FOUND', message); }
