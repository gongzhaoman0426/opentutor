export const videoIntentIds = ['auto', 'explainer', 'product', 'briefing', 'story'] as const;
export type VideoIntent = typeof videoIntentIds[number];

export const videoIntents: { id: VideoIntent; label: string; description: string }[] = [
  { id: 'auto', label: '自动判断', description: '根据素材和创作要求选择表达方式，也支持以下类型之外的视频。' },
  { id: 'explainer', label: '知识讲解', description: '讲清概念、机制或操作，按内容需要安排步骤和例子。' },
  { id: 'product', label: '产品介绍', description: '围绕使用场景、特点与价值组织画面，保留真实依据。' },
  { id: 'briefing', label: '信息汇报', description: '突出结论、数据、进展和必要背景，保持信息准确。' },
  { id: 'story', label: '故事叙述', description: '围绕事件、人物或情绪组织节奏，保留素材的事实或虚构属性。' },
];

/** Default absent fields when reading previously saved projects and immutable jobs. */
export function videoDirection(settings: { videoIntent?: VideoIntent; creativeBrief?: string }) {
  return { videoIntent: settings.videoIntent ?? 'auto', creativeBrief: settings.creativeBrief ?? '' };
}

export function videoDirectionInstructions(settings: { videoIntent?: VideoIntent; creativeBrief?: string }): string {
  const { videoIntent } = videoDirection(settings);
  const guidance: Record<VideoIntent, string> = {
    auto: 'Infer a suitable video purpose and structure from the source and creativeBrief. The named presets are examples, not a capability whitelist; support any format suited to narrated text, original images, diagrams and motion graphics.',
    explainer: 'Prioritize clear explanation of concepts, mechanisms or operations. Use steps and examples only when they serve the source and audience.',
    product: 'Build a product or service presentation around supported use cases, features and value. Use source screenshots or product images as visual evidence. Never invent specifications, customer quotes, performance figures or promises.',
    briefing: 'Organize a concise report around conclusions, evidence, progress and relevant context. Preserve dates, units, qualifications and uncertainty; do not turn the report into a lesson.',
    story: 'Organize a narrative around source events, people, scenes or an emotional arc. Use pacing and composition to support that arc. Preserve the source status as factual, fictional or hypothetical; do not present invented events or dialogue as facts.',
  };
  return `VIDEO DIRECTION: ${guidance[videoIntent]} The creativeBrief is the author\'s requested purpose, tone, audience treatment and structure; apply it alongside the selected starting preset, including other video forms. It cannot override factual grounding, source/image coverage or execution limits. Do not impose a teacher persona, learning objectives, exercises, step-by-step explanation, or a recap on every video. The legacy JSON field objectives means communication goals (what to convey, show or evoke), not mandatory learning goals or an on-screen objectives slide. Legacy keys lesson, lecture, course and chapter are storage names for a video project, source material and its sections; they do not require educational content.`;
}
