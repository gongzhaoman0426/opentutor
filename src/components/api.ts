'use client';

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body.error === 'string' ? body.error : body.error?.message || body.message || `请求失败（${response.status}）`;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '发生了未知错误，请重试。';
export const formatDate = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(value));
export const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
export const activeStatus = (status?: string) => ['queued', 'running', 'cancelling'].includes(status ?? '');
export const jobLabels: Record<string, string> = { queued: '等待开始', running: '正在生成', cancelling: '正在取消', cancelled: '已取消', succeeded: '已完成', failed: '生成失败' };

export const sampleMarkdown = `# 理解复利：时间如何放大增长

## 今天的学习目标
- 理解单利与复利的区别
- 用一个具体例子计算复利
- 认识时间、利率与增长之间的关系

## 单利与复利
单利每期只对最初的本金计算利息。复利则会把上一期的利息加入本金，下一期一起参与计算。

| 方式 | 计算基础 | 增长特征 |
| --- | --- | --- |
| 单利 | 最初的本金 | 每期增加相同金额 |
| 复利 | 本金与累计利息 | 每期增长金额逐渐增加 |

## 一个三年的例子
假设本金为 1,000 元，年利率为 10%，每年计息一次：
1. 第一年结束：1,000 × 1.1 = 1,100 元
2. 第二年结束：1,100 × 1.1 = 1,210 元
3. 第三年结束：1,210 × 1.1 = 1,331 元

复利终值可用公式表示：

$$A = P(1+r)^n$$

其中，P 是本金，r 是每期利率，n 是期数。

## 带走的三个要点
- 复利的关键是利息也参与下一期增长。
- 时间越长，单利与复利的差距越明显。
- 这个计算例子假设利率固定，实际收益并不保证。
`;
