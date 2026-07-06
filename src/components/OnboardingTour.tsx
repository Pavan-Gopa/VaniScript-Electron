import React, { useEffect, useState, useRef } from 'react';
import { AppSettings } from '../types';

interface StepTranslation {
  title: string;
  description: string;
}

interface TourStep {
  targetSelector: string;
  arrowCurveOffset: { dx: number; dy: number };
  bubblePlacement: 'top' | 'bottom' | 'left' | 'right' | 'center';
  en: StepTranslation;
  ru: StepTranslation;
}

interface OnboardingTourProps {
  activeScreen: 'upload' | 'config' | 'processing' | 'review' | 'export' | 'settings' | 'alignment-editor';
  settings: AppSettings;
  onToggleAnnotationMode: (enabled: boolean) => void;
  settingsTab?: number;
  onSettingsTabChange?: (tab: number) => void;
}

const STEPS_BY_SCREEN: Record<string, TourStep[]> = {
  upload: [
    {
      targetSelector: '[data-tour="settings-btn"]',
      arrowCurveOffset: { dx: -30, dy: 40 },
      bubblePlacement: 'left',
      en: {
        title: 'Step 1: Settings & API Keys',
        description: 'Start here! Click the settings gear icon to configure your API keys (Gemini, OpenAI, Claude) or download offline local models for transcription.',
      },
      ru: {
        title: 'Шаг 1: Настройки и Ключи API',
        description: 'Начните отсюда! Нажмите кнопку настроек (шестерёнку), чтобы ввести API-ключи (Gemini, OpenAI) или настроить локальные оффлайн-модели распознавания.',
      },
    },
    {
      targetSelector: '[data-tour="workspace-dropzone"]',
      arrowCurveOffset: { dx: 40, dy: -30 },
      bubblePlacement: 'bottom',
      en: {
        title: 'Step 2: Drag & Drop Upload',
        description: 'Drag and drop any audio or video file here to begin, or click inside the card to browse files from your computer.',
      },
      ru: {
        title: 'Шаг 2: Загрузка файлов',
        description: 'Перетащите сюда любой аудио- или видеофайл для начала работы, либо нажмите на карточку для выбора файла с компьютера.',
      },
    },
    {
      targetSelector: '[data-tour="workspace-record-card"]',
      arrowCurveOffset: { dx: 0, dy: -60 },
      bubblePlacement: 'bottom',
      en: {
        title: 'Step 3: Record Audio',
        description: 'No media file ready? Capture system audio (e.g. from browser playback) or a connected microphone directly in VaniScript!',
      },
      ru: {
        title: 'Шаг 3: Запись звука',
        description: 'Нет готового файла? Запишите системный звук вашего Mac (например, лекцию из браузера) или подключенный микрофон прямо здесь.',
      },
    },
    {
      targetSelector: '[data-tour="workspace-link-card"]',
      arrowCurveOffset: { dx: -40, dy: -30 },
      bubblePlacement: 'bottom',
      en: {
        title: 'Step 4: Web URL Import',
        description: 'Import media directly from the web! Paste a YouTube or SoundCloud link, and VaniScript will download and prepare the audio for you.',
      },
      ru: {
        title: 'Шаг 4: Импорт по ссылке',
        description: 'Вставьте ссылку на YouTube или SoundCloud, и VaniScript автоматически скачает аудиозапись в наилучшем качестве!',
      },
    },
  ],
  config: [
    {
      targetSelector: '[data-tour="config-metadata"]',
      arrowCurveOffset: { dx: 60, dy: 20 },
      bubblePlacement: 'right',
      en: {
        title: 'Step 1: Audio Metadata',
        description: 'Fill in the date, location, and lecturer name. VaniScript uses these metadata details for vocabulary alignment and automatic file naming.',
      },
      ru: {
        title: 'Шаг 1: Метаданные аудио',
        description: 'Заполните дату, место и имя лектора. VaniScript использует эти данные для автокоррекции терминов и именования файлов при экспорте.',
      },
    },
    {
      targetSelector: '[data-tour="target-lang-select"]',
      arrowCurveOffset: { dx: -50, dy: -40 },
      bubblePlacement: 'top',
      en: {
        title: 'Step 2: Target Translation',
        description: 'Select your target language for translation. If you only want transcription in the original language, choose "Keep original (Same)".',
      },
      ru: {
        title: 'Шаг 2: Целевой язык перевода',
        description: 'Выберите язык перевода. Для сохранения оригинальной речи без перевода выберите "Keep original (Same)".',
      },
    },
    {
      targetSelector: '[data-tour="transcription-model-select"]',
      arrowCurveOffset: { dx: 50, dy: -40 },
      bubblePlacement: 'top',
      en: {
        title: 'Step 3: AI Models Selection',
        description: 'Select AI models. Use cloud providers (Gemini, OpenAI) for top speed, or download secure offline local Whisper models for 100% privacy.',
      },
      ru: {
        title: 'Шаг 3: Выбор моделей AI',
        description: 'Выберите AI-модели. Облачные модели (Gemini, OpenAI) обеспечат скорость, а локальные Whisper-модели — 100% конфиденциальность.',
      },
    },
    {
      targetSelector: '[data-tour="start-engine-btn"]',
      arrowCurveOffset: { dx: -40, dy: -60 },
      bubblePlacement: 'top',
      en: {
        title: 'Step 4: Launch Engine',
        description: 'Ready to go! Click this button to segment your audio file and begin the high-precision transcription and translation workflows.',
      },
      ru: {
        title: 'Шаг 4: Запуск движка',
        description: 'Всё настроено! Нажмите эту кнопку, чтобы нарезать аудио и запустить интеллектуальное распознавание.',
      },
    },
  ],
  review: [
    {
      targetSelector: '[data-tour="review-audio-bar"]',
      arrowCurveOffset: { dx: 30, dy: 60 },
      bubblePlacement: 'bottom',
      en: {
        title: 'Step 1: Segment Audio Bar',
        description: 'Listen to the current segment. Press the "Spacebar" on your keyboard to play or pause easily while verifying spelling and wording.',
      },
      ru: {
        title: 'Шаг 1: Аудиоплеер сегмента',
        description: 'Прослушивайте текущую фразу. Воспроизведение можно удобно запускать и останавливать клавишей "Пробел" для проверки на слух.',
      },
    },
    {
      targetSelector: '[data-tour="review-pane-original"]',
      arrowCurveOffset: { dx: 60, dy: 40 },
      bubblePlacement: 'right',
      en: {
        title: 'Step 2: Original Transcription',
        description: 'This pane displays the speech text transcription. Feel free to type in any corrections directly; they are saved automatically.',
      },
      ru: {
        title: 'Шаг 2: Оригинальный текст',
        description: 'Здесь отображается текст распознанной речи. Вы можете править ошибки распознавания прямо в текстовом поле.',
      },
    },
    {
      targetSelector: '[data-tour="review-pane-translation"]',
      arrowCurveOffset: { dx: -60, dy: 40 },
      bubblePlacement: 'left',
      en: {
        title: 'Step 3: Translation Panel',
        description: 'Verify translation side-by-side. You can highlight philosophy terms to add them to your custom VaniScript glossary in one click.',
      },
      ru: {
        title: 'Шаг 3: Перевод и Глоссарий',
        description: 'Справа отображается перевод. Выделяйте санскритские философские термины для быстрого добавления в словарь.',
      },
    },
    {
      targetSelector: '[data-tour="review-editing-model"]',
      arrowCurveOffset: { dx: 20, dy: 50 },
      bubblePlacement: 'bottom',
      en: {
        title: 'Step 4: Choose Editing Model',
        description: 'Select which AI model handles text polishing and glossary correction. Choose cloud Gemini for lightning speed, or a local llama.cpp model for 100% privacy.',
      },
      ru: {
        title: 'Шаг 4: Модель редактирования',
        description: 'Выберите ИИ-модель для полировки текста и работы глоссария. Используйте облачный Gemini для высокой скорости или локальный llama.cpp для полной приватности.',
      },
    },
    {
      targetSelector: '[data-tour="review-view-group"]',
      arrowCurveOffset: { dx: 30, dy: 50 },
      bubblePlacement: 'bottom',
      en: {
        title: 'Step 5: View Mode Toggles',
        description: 'Customize your editor layout! Switch between seeing only original text (Source), only translated text (Translated), or both side-by-side (Dual View).',
      },
      ru: {
        title: 'Шаг 5: Режимы отображения',
        description: 'Настройте внешний вид редактора! Переключайтесь между показом только оригинала (Source), только перевода (Translated) или двух окон вместе (Dual View).',
      },
    },
    {
      targetSelector: '[data-tour="previous-segment-btn"]',
      arrowCurveOffset: { dx: -30, dy: -50 },
      bubblePlacement: 'top',
      en: {
        title: 'Step 6: Navigate Segments',
        description: 'Want to review an earlier segment? Easily jump back to previous audio chunks using the Previous button before approving and advancing.',
      },
      ru: {
        title: 'Шаг 6: Навигация по сегментам',
        description: 'Нужно вернуться назад? Вы можете легко переходить между фрагментами аудио с помощью кнопки "‹ Previous" для повторной проверки.',
      },
    },
    {
      targetSelector: '[data-tour="approve-next-btn"]',
      arrowCurveOffset: { dx: -40, dy: -60 },
      bubblePlacement: 'top',
      en: {
        title: 'Step 7: Approve & Advance',
        description: 'Approve the segment and advance! Press Ctrl/Cmd + Enter to quickly save your updates and jump to the next segment.',
      },
      ru: {
        title: 'Шаг 7: Утвердить и продолжить',
        description: 'Утвердите проверенный сегмент! Используйте сочетание Ctrl/Cmd + Enter для быстрого перехода к следующей фразе.',
      },
    },
  ],
  export: [
    {
      targetSelector: '[data-tour="export-documents"]',
      arrowCurveOffset: { dx: 50, dy: 40 },
      bubblePlacement: 'bottom',
      en: {
        title: 'Step 1: Document Exports',
        description: 'Export the reviewed transcript and captions after all chunks are approved. Use TXT, SRT, VTT, or Markdown when you need text delivery instead of video clips.',
      },
      ru: {
        title: 'Шаг 1: Экспорт Документов',
        description: 'Экспортируйте проверенную транскрибацию и субтитры после approval всех чанков. TXT, SRT, VTT и Markdown подходят для текстовой выдачи без видеоклипов.',
      },
    },
    {
      targetSelector: '[data-tour="shorts-find-moments"]',
      arrowCurveOffset: { dx: 40, dy: -40 },
      bubblePlacement: 'bottom',
      en: {
        title: 'Step 2: Find Shorts/Reels Moments',
        description: 'Choose how many clips you want, set minimum and maximum length, then ask Gemini or your selected planning model to search Source, Source + Target, or Target text for fresh moments.',
      },
      ru: {
        title: 'Шаг 2: Поиск моментов для Shorts/Reels',
        description: 'Выберите количество клипов, минимальную и максимальную длину, затем отправьте Gemini или выбранной модели Source, Source + Target или Target-текст для поиска новых удачных фрагментов.',
      },
    },
    {
      targetSelector: '[data-tour="shorts-choose-clips"]',
      arrowCurveOffset: { dx: -50, dy: 30 },
      bubblePlacement: 'left',
      en: {
        title: 'Step 3: Choose Clips',
        description: 'Review generated clip cards, compare Source and Target wording, open Details, Replace weak timing, delete misses, and keep only clips you want to export.',
      },
      ru: {
        title: 'Шаг 3: Выбор клипов',
        description: 'Проверьте карточки клипов, сравните Source и Target, откройте Details, замените слабые тайминги, удалите лишнее и оставьте только нужные ролики.',
      },
    },
    {
      targetSelector: '[data-tour="shorts-edit-clip"]',
      arrowCurveOffset: { dx: -30, dy: 40 },
      bubblePlacement: 'left',
      en: {
        title: 'Step 4: Visual Editor',
        description: 'Use Edit Clip to open the Visual Editor. There you can sync playback, adjust subtitle blocks, crop and animate the frame, tune captions, and save edits back to the clip card.',
      },
      ru: {
        title: 'Шаг 4: Визуальный редактор',
        description: 'Нажмите Edit Clip, чтобы открыть визуальный редактор. Там можно синхронизировать воспроизведение, править блоки субтитров, кадрирование, анимацию, стиль титров и сохранить изменения в карточку.',
      },
    },
    {
      targetSelector: '[data-tour="shorts-export-settings"]',
      arrowCurveOffset: { dx: 40, dy: -30 },
      bubblePlacement: 'top',
      en: {
        title: 'Step 5: Export Settings',
        description: 'Pick format, resolution, and frame rate before rendering. Source-based keeps the source video properties when that is the cleanest choice.',
      },
      ru: {
        title: 'Шаг 5: Настройки экспорта',
        description: 'Перед рендером выберите формат, разрешение и частоту кадров. Source-based сохраняет параметры исходного видео, когда это самый аккуратный вариант.',
      },
    },
    {
      targetSelector: '[data-tour="shorts-export-actions"]',
      arrowCurveOffset: { dx: -40, dy: 30 },
      bubblePlacement: 'top',
      en: {
        title: 'Step 6: Export Ideas or Videos',
        description: 'Export ideas JSON/TXT for planning notes, or render selected videos with HyperFrames. Clip metadata and captions stay editable later.',
      },
      ru: {
        title: 'Шаг 6: Экспорт идей или видео',
        description: 'Экспортируйте идеи в JSON/TXT для заметок или рендерите выбранные видео через HyperFrames. Метаданные клипов и субтитры останутся редактируемыми.',
      },
    },
    {
      targetSelector: '[data-tour="export-footer-actions"]',
      arrowCurveOffset: { dx: 0, dy: -40 },
      bubblePlacement: 'top',
      en: {
        title: 'Step 7: Continue Working',
        description: 'Use Back to Chunks to return to reviewed chunks, Sessions to open/import projects, or New Session to start another video without hunting through menus.',
      },
      ru: {
        title: 'Шаг 7: Продолжение работы',
        description: 'Back to Chunks возвращает к проверенным чанкам, Sessions открывает проекты и импорт, а New Session запускает новое видео без поиска нужной команды в меню.',
      },
    },
  ],
  settings: [
    {
      targetSelector: '[data-tour="settings-tab-0"]',
      arrowCurveOffset: { dx: -20, dy: 40 },
      bubblePlacement: 'bottom',
      en: {
        title: 'API Keys',
        description: 'Configure your cloud API keys for Google Gemini, OpenAI, or Anthropic. Cloud models offer maximum processing speed for transcription and translation.',
      },
      ru: {
        title: 'Ключи API',
        description: 'Настройте ключи API для Google Gemini, OpenAI или Anthropic. Облачные модели обеспечивают максимальную скорость распознавания и перевода.',
      },
    },
    {
      targetSelector: '[data-tour="settings-tab-1"]',
      arrowCurveOffset: { dx: -20, dy: 40 },
      bubblePlacement: 'bottom',
      en: {
        title: 'Local AI Models',
        description: 'Download offline Whisper models for speech recognition and Llama.cpp models for translation and text polishing. Once downloaded, VaniScript works 100% privately and offline.',
      },
      ru: {
        title: 'Локальные модели AI',
        description: 'Загрузите оффлайн-модели Whisper для распознавания речи и модели Llama.cpp для перевода и полировки. Это позволит работать полностью локально и конфиденциально без интернета.',
      },
    },
    {
      targetSelector: '[data-tour="settings-tab-2"]',
      arrowCurveOffset: { dx: -20, dy: 40 },
      bubblePlacement: 'bottom',
      en: {
        title: 'Appearance Options',
        description: 'Choose between Dark and Light themes, select your preferred reading font family (JetBrains Mono, Inter, Georgia), and scale the user interface text size.',
      },
      ru: {
        title: 'Оформление и темы',
        description: 'Выберите темную или светлую тему, настройте шрифт для чтения (JetBrains Mono, Inter, Georgia) и измените масштаб интерфейса.',
      },
    },
    {
      targetSelector: '[data-tour="settings-tab-3"]',
      arrowCurveOffset: { dx: -20, dy: 40 },
      bubblePlacement: 'bottom',
      en: {
        title: 'Custom Glossary',
        description: 'Add custom vocabulary terms and correct spelling variants (e.g. Sanskrit terms, abbreviations, names) to ensure consistent and accurate AI results.',
      },
      ru: {
        title: 'Словарь терминов',
        description: 'Добавляйте сложные термины и варианты их правильного написания (например, санскритские слова, имена, аббревиатуры) для автокоррекции.',
      },
    },
    {
      targetSelector: '[data-tour="settings-tab-4"]',
      arrowCurveOffset: { dx: -20, dy: 40 },
      bubblePlacement: 'bottom',
      en: {
        title: 'Smart Chunking',
        description: 'Configure audio slicing. Choose "By Silence" to naturally cut audio at natural speech pauses (recommended) or set fixed duration intervals.',
      },
      ru: {
        title: 'Нарезка аудио (Chunking)',
        description: 'Настройте нарезку аудиофайла. Выберите "By Silence" для умной нарезки на естественных паузах (рекомендуется) или укажите фиксированный шаг.',
      },
    },
    {
      targetSelector: '[data-tour="settings-tab-5"]',
      arrowCurveOffset: { dx: -20, dy: 40 },
      bubblePlacement: 'bottom',
      en: {
        title: 'Language Defaults',
        description: 'Set the default source language of your recordings (or auto-detect) and select the default translation target language.',
      },
      ru: {
        title: 'Языки по умолчанию',
        description: 'Задайте язык оригинала по умолчанию (или включите автоопределение) и выберите целевой язык для перевода.',
      },
    },
    {
      targetSelector: '[data-tour="settings-tab-6"]',
      arrowCurveOffset: { dx: -20, dy: 40 },
      bubblePlacement: 'bottom',
      en: {
        title: 'AI Prompts Customization',
        description: 'Fine-tune system instructions sent to Gemini and llama.cpp for punctuation alignment, grammar polishing, translation, and summaries.',
      },
      ru: {
        title: 'Настройка промптов',
        description: 'Отредактируйте системные инструкции (промпты) для ИИ при расстановке пунктуации, полировке грамматики, переводе и резюмировании.',
      },
    },
    {
      targetSelector: '[data-tour="settings-tab-7"]',
      arrowCurveOffset: { dx: -20, dy: 40 },
      bubblePlacement: 'bottom',
      en: {
        title: 'Usage & Cost Stats',
        description: 'Monitor API token counts, audio minutes processed, and estimated usage costs. You can set budget limits to prevent unexpected billing.',
      },
      ru: {
        title: 'Статистика и расходы',
        description: 'Отслеживайте количество токенов, минуты обработанного аудио и примерную стоимость. Устанавливайте лимиты бюджета для контроля расходов.',
      },
    },
  ],
  'alignment-editor': [
    {
      targetSelector: '.alignment-lang-toggle',
      arrowCurveOffset: { dx: -30, dy: 40 },
      bubblePlacement: 'bottom',
      en: {
        title: 'Source / Target Toggle',
        description: 'Switch between editing your Source (original) and Target (translation) subtitles.',
      },
      ru: {
        title: 'Выбор языка субтитров',
        description: 'Переключайтесь между редактированием оригинальных (Source) и переведённых (Target) субтитров.',
      },
    },
    {
      targetSelector: '.btn-dl-sync',
      arrowCurveOffset: { dx: -30, dy: 40 },
      bubblePlacement: 'bottom',
      en: {
        title: 'Bilingual Sync',
        description: 'When Sync is enabled, visual styling and keyframes are automatically mirrored between Source and Target languages.',
      },
      ru: {
        title: 'Двуязычная синхронизация',
        description: 'При включенной синхронизации визуальные стили и ключевые кадры автоматически копируются между языками.',
      },
    },
    {
      targetSelector: '.alignment-preview',
      arrowCurveOffset: { dx: 40, dy: -30 },
      bubblePlacement: 'bottom',
      en: {
        title: 'Video Preview & Panning',
        description: 'Watch the video. You can drag and zoom the video inside this frame to set keyframes and follow the lecturer.',
      },
      ru: {
        title: 'Превью и позиционирование видео',
        description: 'Вы можете перетаскивать и масштабировать видео внутри этой рамки, чтобы настраивать ключевые кадры следования за спикером.',
      },
    },
    {
      targetSelector: '.alignment-multitrack',
      arrowCurveOffset: { dx: 0, dy: -60 },
      bubblePlacement: 'top',
      en: {
        title: 'Captions Timeline',
        description: 'Adjust individual word timings! Click and drag words to align them precisely with the audio waveform.',
      },
      ru: {
        title: 'Таймлайн субтитров',
        description: 'Настраивайте тайминг отдельных слов! Перетаскивайте и выравнивайте слова по звуковой волне для идеальной синхронизации.',
      },
    },
    {
      targetSelector: '.alignment-right',
      arrowCurveOffset: { dx: -60, dy: 40 },
      bubblePlacement: 'left',
      en: {
        title: 'Visual Inspector',
        description: 'Customize subtitle fonts, colors, background styles, add logos, text overlays, or extra audio tracks in separate layers.',
      },
      ru: {
        title: 'Инспектор стилей',
        description: 'Настраивайте шрифты, цвета, стили фона, добавляйте логотипы, текстовые слои или дополнительные аудиодорожки.',
      },
    },
    {
      targetSelector: '.alignment-save-btn',
      arrowCurveOffset: { dx: -40, dy: 40 },
      bubblePlacement: 'bottom',
      en: {
        title: 'Save Edits',
        description: 'Make sure to save your edits! Click this button to save your changes and continue refining your clip.',
      },
      ru: {
        title: 'Сохранение изменений',
        description: 'Обязательно сохраняйте изменения! Нажмите кнопку "Save edits", чтобы записать прогресс.',
      },
    },
  ],
};

const BUBBLE_WIDTH = 380;
const BUBBLE_HEIGHT = 180;

export function OnboardingTour({ activeScreen, settings, onToggleAnnotationMode, settingsTab, onSettingsTabChange }: OnboardingTourProps) {
  const [currentStepIdx, setCurrentStepIdx] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [bubblePos, setBubblePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [windowSize, setWindowSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [draggedPos, setDraggedPos] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ startX: number; startY: number; initialX: number; initialY: number } | null>(null);

  // Intelligent language switcher defaulting to system locale (Russian if system language is Russian, else English)
  const [tourLang, setTourLang] = useState<'en' | 'ru'>(() => {
    return navigator.language.startsWith('ru') ? 'ru' : 'en';
  });

  // Get effective steps
  const steps = STEPS_BY_SCREEN[activeScreen] || [];
  const activeStep = steps[currentStepIdx];

  // Disable tour if settings.annotationMode is false or if no steps exist
  if (!settings.annotationMode || steps.length === 0) {
    return null;
  }

  // Effect to reset step index when screen changes
  useEffect(() => {
    setCurrentStepIdx(0);
    setDraggedPos(null);
  }, [activeScreen]);

  // Reset dragged position when step index changes
  useEffect(() => {
    setDraggedPos(null);
  }, [currentStepIdx]);

  // Automatically change settings tab depending on the onboarding step
  useEffect(() => {
    if (activeScreen === 'settings' && onSettingsTabChange) {
      if (currentStepIdx >= 0 && currentStepIdx <= 7) {
        onSettingsTabChange(currentStepIdx);
      }
    }
  }, [currentStepIdx, activeScreen, onSettingsTabChange]);

  // Handle window resizing, scrolling & interval check for elements rendering
  useEffect(() => {
    const handleUpdate = () => {
      setWindowSize({ w: window.innerWidth, h: window.innerHeight });
      if (!activeStep) return;

      const element = document.querySelector(activeStep.targetSelector);
      if (element) {
        const rect = element.getBoundingClientRect();
        setTargetRect(rect);

        // Calculate bubble coordinate relative to target rect
        const bubbleWidth = BUBBLE_WIDTH;
        const bubbleHeight = BUBBLE_HEIGHT;
        
        let x = window.innerWidth / 2 - bubbleWidth / 2;
        let y = window.innerHeight / 2 - bubbleHeight / 2;

        const gap = 60; // Generous gap for breathing room (air)
        let placement = activeStep.bubblePlacement;

        // Smart flip collision detection: if there is not enough room, flip to the opposite side
        if (placement === 'bottom') {
          const projectedY = rect.bottom + gap;
          if (projectedY + bubbleHeight > window.innerHeight - 20) {
            placement = 'top';
          }
        } else if (placement === 'top') {
          const projectedY = rect.top - bubbleHeight - gap;
          if (projectedY < 80) {
            placement = 'bottom';
          }
        } else if (placement === 'left') {
          const projectedX = rect.left - bubbleWidth - gap;
          if (projectedX < 20) {
            placement = 'right';
          }
        } else if (placement === 'right') {
          const projectedX = rect.right + gap;
          if (projectedX + bubbleWidth > window.innerWidth - 20) {
            placement = 'left';
          }
        }

        // Apply final coordinates based on placement
        if (placement === 'bottom') {
          x = rect.left + rect.width / 2 - bubbleWidth / 2;
          y = rect.bottom + gap;
        } else if (placement === 'top') {
          x = rect.left + rect.width / 2 - bubbleWidth / 2;
          y = rect.top - bubbleHeight - gap;
        } else if (placement === 'left') {
          x = rect.left - bubbleWidth - gap;
          y = rect.top + rect.height / 2 - bubbleHeight / 2;
        } else if (placement === 'right') {
          x = rect.right + gap;
          y = rect.top + rect.height / 2 - bubbleHeight / 2;
        }

        // Clamp bubble positions to viewport safety boundaries
        x = Math.max(20, Math.min(window.innerWidth - bubbleWidth - 20, x));
        y = Math.max(80, Math.min(window.innerHeight - bubbleHeight - 20, y));

        setBubblePos({ x, y });
      } else {
        setTargetRect(null);
        // Center position if target not found
        setBubblePos({
          x: window.innerWidth / 2 - BUBBLE_WIDTH / 2,
          y: window.innerHeight / 2 - BUBBLE_HEIGHT / 2,
        });
      }
    };

    handleUpdate();

    // Set a quick interval to poll for rendering changes (since pages load dynamically)
    const interval = setInterval(handleUpdate, 350);
    window.addEventListener('resize', handleUpdate);
    window.addEventListener('scroll', handleUpdate, true);

    return () => {
      clearInterval(interval);
      window.removeEventListener('resize', handleUpdate);
      window.removeEventListener('scroll', handleUpdate, true);
    };
  }, [activeStep, currentStepIdx, activeScreen]);

  const handleNext = () => {
    if (currentStepIdx < steps.length - 1) {
      setCurrentStepIdx(currentStepIdx + 1);
    } else {
      // Completed last step on this screen
      onToggleAnnotationMode(false);
    }
  };

  const handlePrev = () => {
    if (currentStepIdx > 0) {
      setCurrentStepIdx(currentStepIdx - 1);
    }
  };

  const handleSkip = () => {
    onToggleAnnotationMode(false);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('.onboarding-lang-switcher')) {
      return;
    }
    // Set ref values
    const startX = e.clientX;
    const startY = e.clientY;
    const initialX = draggedPos ? draggedPos.x : bubblePos.x;
    const initialY = draggedPos ? draggedPos.y : bubblePos.y;
    dragStartRef.current = { startX, startY, initialX, initialY };
    setIsDragging(true);
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const { startX, startY, initialX, initialY } = dragStartRef.current;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newX = Math.max(10, Math.min(window.innerWidth - BUBBLE_WIDTH - 10, initialX + dx));
      const newY = Math.max(50, Math.min(window.innerHeight - BUBBLE_HEIGHT - 20, initialY + dy));
      setDraggedPos({ x: newX, y: newY });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  // Draw arrow path using Bezier curves
  const renderArrow = () => {
    if (!targetRect || !activeStep) return null;

    // Source of arrow: bubble edge facing target
    const bubbleW = BUBBLE_WIDTH;
    const bubbleH = BUBBLE_HEIGHT;
    const currentX = draggedPos ? draggedPos.x : bubblePos.x;
    const currentY = draggedPos ? draggedPos.y : bubblePos.y;

    let sx = currentX + bubbleW / 2;
    let sy = currentY + bubbleH / 2;

    // Target of arrow: target center or closest edge
    let tx = targetRect.left + targetRect.width / 2;
    let ty = targetRect.top + targetRect.height / 2;

    // Dynamically choose starting point on bubble based on relative position to target
    if (ty < currentY) {
      // Target is above bubble
      sx = currentX + bubbleW / 2;
      sy = currentY;
      ty = targetRect.bottom;
    } else if (ty > currentY + bubbleH) {
      // Target is below bubble
      sx = currentX + bubbleW / 2;
      sy = currentY + bubbleH;
      ty = targetRect.top;
    } else if (tx < currentX) {
      // Target is to the left of bubble
      sx = currentX;
      sy = currentY + bubbleH / 2;
      tx = targetRect.right;
    } else {
      // Target is to the right of bubble
      sx = currentX + bubbleW;
      sy = currentY + bubbleH / 2;
      tx = targetRect.left;
    }

    // Dynamic Bezier Control point with organic custom offsets
    const mx = (sx + tx) / 2 + activeStep.arrowCurveOffset.dx;
    const my = (sy + ty) / 2 + activeStep.arrowCurveOffset.dy;

    const pathData = `M ${sx} ${sy} Q ${mx} ${my} ${tx} ${ty}`;

    return (
      <svg className="onboarding-svg-overlay" style={{ width: windowSize.w, height: windowSize.h }}>
        <defs>
          <marker
            id="onboarding-arrowhead"
            markerWidth="10"
            markerHeight="10"
            refX="6"
            refY="3"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L0,6 L8,3 Z" fill="var(--accent)" />
          </marker>
        </defs>
        {/* Draw curved arrow path */}
        <path
          d={pathData}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2.5"
          strokeDasharray="6 4"
          markerEnd="url(#onboarding-arrowhead)"
          className="onboarding-arrow-path"
        />
      </svg>
    );
  };

  const activeContent = activeStep ? activeStep[tourLang] : null;
  const currentX = draggedPos ? draggedPos.x : bubblePos.x;
  const currentY = draggedPos ? draggedPos.y : bubblePos.y;

  return (
    <div className="onboarding-tour-root">
      {/* Target spotlight backing */}
      {targetRect && (
        <div
          className="onboarding-spotlight"
          style={{
            top: targetRect.top - 6,
            left: targetRect.left - 6,
            width: targetRect.width + 12,
            height: targetRect.height + 12,
          }}
        />
      )}

      {/* Renders Arrow and Glow rings */}
      {renderArrow()}

      {/* Annotation Handwritten bubble card */}
      <div
        className={`onboarding-bubble ${isDragging ? 'dragging' : ''}`}
        style={{
          left: `${currentX}px`,
          top: `${currentY}px`,
        }}
        onMouseDown={handleMouseDown}
      >
        <div className="onboarding-bubble-header">
          <h4>{activeContent?.title}</h4>
          
          <div className="onboarding-header-controls">
            {/* Interactive language switcher */}
            <div className="onboarding-lang-switcher" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className={tourLang === 'en' ? 'active' : ''}
                onClick={() => setTourLang('en')}
                title="English Language"
              >
                EN
              </button>
              <button
                type="button"
                className={tourLang === 'ru' ? 'active' : ''}
                onClick={() => setTourLang('ru')}
                title="Русский язык"
              >
                RU
              </button>
            </div>

            <span className="onboarding-step-counter">
              {tourLang === 'ru' 
                ? `Шаг ${currentStepIdx + 1} из ${steps.length}` 
                : `Step ${currentStepIdx + 1} of ${steps.length}`}
            </span>
          </div>
        </div>
        
        <div className="onboarding-bubble-body">
          <p>{activeContent?.description}</p>
        </div>
        
        <div className="onboarding-bubble-footer">
          <button className="onboarding-btn-skip" onClick={handleSkip}>
            {tourLang === 'ru' ? 'Скрыть подсказки' : 'Skip walkthrough'}
          </button>
          <div style={{ display: 'flex', gap: 6 }}>
            {currentStepIdx > 0 && (
              <button className="onboarding-btn-prev" onClick={handlePrev}>
                {tourLang === 'ru' ? '‹ Назад' : '‹ Back'}
              </button>
            )}
            <button className="onboarding-btn-next" onClick={handleNext}>
              {currentStepIdx < steps.length - 1 
                ? (tourLang === 'ru' ? 'Далее ›' : 'Next ›') 
                : (tourLang === 'ru' ? 'Завершить' : 'Finish')}
            </button>
          </div>
        </div>
      </div>

      {/* Persistent mini-badge to show the user they can toggle annotations */}
      <div className="onboarding-mini-badge" onClick={() => onToggleAnnotationMode(false)}>
        <span>{tourLang === 'ru' ? '💡 Подсказки включены (Отключить)' : '💡 Walkthrough Active (Turn Off)'}</span>
      </div>
    </div>
  );
}
