export const zh = {
  appTitle: 'OpenTutor · 视频创作工作室',
  appDescription: '把 Markdown 文稿、图片与创意变成有声音、有画面的视频。',
  interfaceLanguage: '界面语言',
  requestFailed: '请求失败（{{status}}）',
  unknownError: '发生了未知错误，请重试。',
  jobStatuses: { queued: '等待开始', running: '正在生成', cancelling: '正在取消', cancelled: '已取消', succeeded: '已完成', failed: '生成失败' },
  render: {
    preparing: '准备导出', rendering: '绘制视频画面', encoding: '编码视频', muxing: '合成音视频', completed: '导出完成',
    frames: '画面 {{rendered}}/{{total}} 帧', speed: '{{speed}} 帧/秒', elapsed: '已用 {{time}}', duration: '用时 {{time}}',
    minutesSeconds: '{{minutes}} 分 {{seconds}} 秒', seconds: '{{seconds}} 秒',
  },
};
export const en = {
  appTitle: 'OpenTutor · Video Studio',
  appDescription: 'Turn Markdown, images, and ideas into videos with visuals and narration.',
  interfaceLanguage: 'Interface language',
  requestFailed: 'Request failed ({{status}})',
  unknownError: 'Something went wrong. Please try again.',
  jobStatuses: { queued: 'Queued', running: 'Generating', cancelling: 'Cancelling', cancelled: 'Cancelled', succeeded: 'Completed', failed: 'Generation failed' },
  render: {
    preparing: 'Preparing export', rendering: 'Rendering frames', encoding: 'Encoding video', muxing: 'Combining audio and video', completed: 'Export complete',
    frames: '{{rendered}}/{{total}} frames', speed: '{{speed}} fps', elapsed: 'Elapsed {{time}}', duration: 'Duration {{time}}',
    minutesSeconds: '{{minutes}}m {{seconds}}s', seconds: '{{seconds}}s',
  },
};
