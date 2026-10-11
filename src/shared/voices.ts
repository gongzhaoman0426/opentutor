/** Locale and ShortName formats returned by Microsoft's free voice catalogue. */
export const VOICE_LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){1,3}$/;
export const VOICE_NAME_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){1,3}-[A-Za-z][A-Za-z0-9]*Neural$/;
export interface Voice { name: string; locale: string; gender: string; displayName: string }

/** The last ShortName segment is the voice name, even for script/dialect locales. */
export function voiceLocale(voice: string): string {
  return VOICE_NAME_PATTERN.test(voice) ? voice.slice(0, voice.lastIndexOf('-')) : '';
}

const languageNames: Record<string, string> = {
  'zh-CN': '中文（普通话）', 'zh-TW': '中文（台湾）', 'zh-HK': '中文（粤语，香港）',
  'zh-CN-liaoning': '中文（东北话）', 'zh-CN-shaanxi': '中文（陕西话）',
  'iu-Cans-CA': '因纽特语（加拿大，音节文字）', 'iu-Latn-CA': '因纽特语（加拿大，拉丁字母）',
};
export function languageLabel(locale: string): string {
  if (languageNames[locale]) return languageNames[locale];
  try { return new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of(locale) || locale; }
  catch { return locale; }
}

const voiceNames: Record<string, string> = { Xiaoxiao: '晓晓', Xiaoyi: '晓伊', Yunjian: '云健', Yunxi: '云希', Yunxia: '云夏', Yunyang: '云扬' };
export function voiceLabel(voice: Voice): string {
  const name = voice.name.slice(voice.locale.length + 1).replace(/Neural$/, '');
  const gender = voice.gender === 'Female' ? '女声' : voice.gender === 'Male' ? '男声' : voice.gender;
  return [voiceNames[name] || name, gender].filter(Boolean).join(' · ');
}

const preferredLanguages = ['zh-CN', 'zh-TW', 'zh-HK', 'en-US', 'en-GB', 'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'es-ES'];
export function availableLanguages(voices: Voice[]): { locale: string; label: string }[] {
  const rank = (locale: string) => { const index = preferredLanguages.indexOf(locale); return index < 0 ? preferredLanguages.length : index; };
  return [...new Set(voices.map(voice => voice.locale))].map(locale => ({ locale, label: languageLabel(locale) }))
    .sort((a, b) => rank(a.locale) - rank(b.locale) || a.label.localeCompare(b.label, 'zh-CN') || a.locale.localeCompare(b.locale));
}

const preferredVoices: Record<string, string> = {
  'zh-CN': 'zh-CN-XiaoxiaoNeural', 'en-US': 'en-US-AriaNeural', 'en-GB': 'en-GB-SoniaNeural',
  'ja-JP': 'ja-JP-NanamiNeural', 'ko-KR': 'ko-KR-SunHiNeural',
};
export function defaultVoiceForLanguage(voices: Voice[], locale: string, currentVoice?: string): string {
  const matching = voices.filter(voice => voice.locale === locale);
  return matching.find(voice => voice.name === currentVoice)?.name
    || matching.find(voice => voice.name === preferredVoices[locale])?.name
    || matching[0]?.name || '';
}

const previewSamples: Record<string, string> = {
  zh: '欢迎来到 OpenTutor。用文字和图片，创作属于你的视频。',
  'zh-TW': '歡迎來到 OpenTutor。用文字和圖片，創作屬於你的影片。',
  'zh-HK': '歡迎嚟到 OpenTutor。用文字同圖片，創作屬於你嘅影片。',
  en: 'Welcome to OpenTutor. Turn your words and images into expressive videos.',
  ja: 'OpenTutorへようこそ。文章と画像から、あなたの動画を作りましょう。',
  ko: 'OpenTutor에 오신 것을 환영합니다. 글과 이미지로 나만의 영상을 만들어 보세요.',
  fr: 'Bienvenue sur OpenTutor. Créez votre vidéo à partir de textes et d’images.',
  de: 'Willkommen bei OpenTutor. Erstellen Sie aus Texten und Bildern Ihr eigenes Video.',
  es: 'Bienvenido a OpenTutor. Crea tu propio vídeo a partir de textos e imágenes.',
  pt: 'Bem-vindo ao OpenTutor. Crie o seu vídeo a partir de textos e imagens.',
  it: 'Benvenuto su OpenTutor. Crea il tuo video a partire da testi e immagini.',
  ru: 'Добро пожаловать в OpenTutor. Создавайте свои видео из текстов и изображений.',
  uk: 'Ласкаво просимо до OpenTutor. Створюйте відео з текстів і зображень.',
  ar: 'مرحباً بك في OpenTutor. أنشئ فيديو من النصوص والصور.',
  hi: 'OpenTutor में आपका स्वागत है। अपने शब्दों और चित्रों से वीडियो बनाइए।',
  id: 'Selamat datang di OpenTutor. Buat video Anda sendiri dari teks dan gambar.',
  ms: 'Selamat datang ke OpenTutor. Cipta video anda daripada teks dan gambar.',
  vi: 'Chào mừng bạn đến với OpenTutor. Tạo video của riêng bạn từ văn bản và hình ảnh.',
  th: 'ยินดีต้อนรับสู่ OpenTutor สร้างวิดีโอของคุณจากข้อความและรูปภาพ',
  tr: 'OpenTutor’a hoş geldiniz. Metin ve resimlerden kendi videonuzu oluşturun.',
  nl: 'Welkom bij OpenTutor. Maak je eigen video van teksten en afbeeldingen.',
  pl: 'Witamy w OpenTutor. Twórz własne filmy z tekstów i obrazów.',
  sv: 'Välkommen till OpenTutor. Skapa din egen video med text och bilder.',
  da: 'Velkommen til OpenTutor. Lav din egen video med tekst og billeder.',
  nb: 'Velkommen til OpenTutor. Lag din egen video med tekst og bilder.',
  fi: 'Tervetuloa OpenTutoriin. Luo oma videosi tekstistä ja kuvista.',
  cs: 'Vítejte v OpenTutor. Vytvořte si vlastní video z textů a obrázků.',
  el: 'Καλώς ήρθατε στο OpenTutor. Δημιουργήστε το δικό σας βίντεο από κείμενα και εικόνες.',
  he: 'ברוכים הבאים ל־OpenTutor. צרו סרטון משלכם מטקסט ותמונות.',
};
export function voicePreviewText(voice: string): string {
  const locale = voiceLocale(voice);
  // For other catalogue languages, the voice reads digits in its own language;
  // do not send an English sentence to an unrelated monolingual voice.
  return previewSamples[locale] || previewSamples[locale.split('-')[0]] || '1, 2, 3. 4, 5, 6.';
}
