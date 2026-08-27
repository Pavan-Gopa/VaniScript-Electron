'use strict';

// This module is intentionally dependency-free so Electron Main and the Vite
// renderer consume one pure, native-shaped help catalog.

const HELP_LANGUAGE_VALUES = Object.freeze(['en', 'ru']);
const HELP_SCREEN_VALUES = Object.freeze([
  'upload',
  'config',
  'processing',
  'review',
  'export',
  'visualEditor',
]);

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value === null || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, child] of Object.entries(value)) copy[key] = cloneValue(child);
  return copy;
}

function pair(en, ru) {
  return { en, ru };
}

function topic({ id, category, screen = null, title, summary, requirements = [], steps, troubleshooting = [], relatedTopicIDs = [], keywords = [] }) {
  return {
    id,
    category,
    screen,
    title,
    summary,
    requirements,
    steps,
    troubleshooting,
    relatedTopicIDs,
    keywords,
  };
}

// The copy below is a checked-in Electron projection of
// AppleSilicon/Sources/VaniScriptCore/VaniScriptHelpCatalog.swift. Keep IDs,
// order, labels, and bilingual keyword corpus in parity with that anchor.
const HELP_TOPICS = deepFreeze([
  topic({
    id: 'getting-started',
    category: 'Getting Started',
    screen: 'upload',
    title: pair('Create your first project', 'Создание первого проекта'),
    summary: pair('The normal route is Upload, Config, Processing, Review, then Export.', 'Обычный маршрут: Upload, Config, Processing, Review, затем Export.'),
    steps: [
      pair('Choose or record source media on Upload.', 'Выберите или запишите исходное медиа на экране Upload.'),
      pair('Confirm language and models on Config.', 'Проверьте язык и модели на экране Config.'),
      pair('Click Initialize Engine and wait for Review.', 'Нажмите Initialize Engine и дождитесь Review.'),
      pair('Correct and approve every segment.', 'Исправьте и утвердите каждый сегмент.'),
      pair('Open Export for documents or Shorts.', 'Откройте Export для документов или Shorts.'),
    ],
    relatedTopicIDs: ['import-media', 'configure-engine', 'review-transcript', 'export-documents'],
    keywords: ['first project beginner start workflow первый проект начать новичок маршрут'],
  }),
  topic({
    id: 'import-media',
    category: 'Import',
    screen: 'upload',
    title: pair('Import an audio or video file', 'Импорт аудио- или видеофайла'),
    summary: pair('Use a local MP3, WAV, M4A, MP4, MOV, or lecture media file.', 'Используйте локальный MP3, WAV, M4A, MP4, MOV или файл лекции.'),
    steps: [
      pair('Open Upload.', 'Откройте Upload.'),
      pair('Click Upload Audio / Video.', 'Нажмите Upload Audio / Video.'),
      pair('Choose the source file in the macOS file picker.', 'Выберите исходный файл в системном окне macOS.'),
      pair('Wait for Config to open and verify the detected duration and metadata.', 'Дождитесь Config и проверьте определённую длительность и метаданные.'),
    ],
    troubleshooting: [
      pair('If Config does not open, verify that the file exists and uses a supported media format.', 'Если Config не открывается, проверьте наличие файла и поддерживаемый формат.'),
    ],
    relatedTopicIDs: ['configure-engine', 'import-link', 'record-audio'],
    keywords: ['upload file import mp3 wav m4a mp4 mov загрузить файл импорт'],
  }),
  topic({
    id: 'import-link',
    category: 'Import',
    screen: 'upload',
    title: pair('Import media from a link', 'Импорт медиа по ссылке'),
    summary: pair('Download supported internet media and continue through the normal transcription workflow.', 'Загрузите поддерживаемое интернет-медиа и продолжите обычный процесс транскрибации.'),
    requirements: [
      pair('An internet connection and a supported public media URL.', 'Нужны интернет-соединение и поддерживаемая публичная ссылка.'),
    ],
    steps: [
      pair('On Upload, click Import Link.', 'На экране Upload нажмите Import Link.'),
      pair('Paste the complete media URL.', 'Вставьте полную ссылку на медиа.'),
      pair('Start the import and wait until VaniScript opens Config.', 'Запустите импорт и дождитесь, когда VaniScript откроет Config.'),
    ],
    troubleshooting: [
      pair('Private, expired, unsupported, or access-restricted links may fail.', 'Приватные, устаревшие, неподдерживаемые или ограниченные ссылки могут не загрузиться.'),
    ],
    relatedTopicIDs: ['import-media', 'configure-engine'],
    keywords: ['url youtube soundcloud download link ссылка скачать интернет'],
  }),
  topic({
    id: 'record-audio',
    category: 'Import',
    screen: 'upload',
    title: pair('Record an audio source', 'Запись источника аудио'),
    summary: pair('Capture system audio or a microphone, review it, then send it to transcription.', 'Запишите системный звук или микрофон, прослушайте запись и отправьте её на транскрибацию.'),
    steps: [
      pair('On Upload, click Record Audio Source.', 'На экране Upload нажмите Record Audio Source.'),
      pair('Choose System Audio or Mic / Virtual and select an input when needed.', 'Выберите System Audio или Mic / Virtual и при необходимости укажите вход.'),
      pair('Click Start Recording, then Stop & Review.', 'Нажмите Start Recording, затем Stop & Review.'),
      pair('Listen to the preview and click Save & Continue, or Retake.', 'Прослушайте preview и нажмите Save & Continue либо Retake.'),
    ],
    troubleshooting: [
      pair('Grant the macOS recording permissions requested by VaniScript.', 'Предоставьте VaniScript запрошенные macOS разрешения на запись.'),
      pair('If system audio is unavailable, use a microphone or a virtual input such as BlackHole or Loopback.', 'Если системный звук недоступен, используйте микрофон или виртуальный вход, например BlackHole или Loopback.'),
    ],
    relatedTopicIDs: ['configure-engine', 'import-media'],
    keywords: ['record microphone system audio capture blackhole loopback запись микрофон системный звук'],
  }),
  topic({
    id: 'configure-engine',
    category: 'Processing',
    screen: 'config',
    title: pair('Configure transcription and translation', 'Настройка транскрибации и перевода'),
    summary: pair('Set metadata, target language, transcription model, translation model, and output formats.', 'Укажите метаданные, язык перевода, модели транскрибации и перевода, а также форматы вывода.'),
    requirements: [
      pair('A source file must already be selected.', 'Исходный файл уже должен быть выбран.'),
    ],
    steps: [
      pair('Check Date, Location, Lecturer, and Interviewer / Participants.', 'Проверьте Date, Location, Lecturer и Interviewer / Participants.'),
      pair('Choose Target Language. Select same to skip translation.', 'Выберите Target Language. Укажите same, чтобы не выполнять перевод.'),
      pair('Choose Transcription Model and, when translating, Translation Model.', 'Выберите Transcription Model и, если нужен перевод, Translation Model.'),
      pair('Click Initialize Engine.', 'Нажмите Initialize Engine.'),
    ],
    troubleshooting: [
      pair('If a model is missing, open Settings > Models and download or locate it.', 'Если модель отсутствует, откройте Settings > Models и загрузите либо укажите её расположение.'),
    ],
    relatedTopicIDs: ['manage-models', 'process-media'],
    keywords: ['config language provider initialize engine metadata модель язык настройка'],
  }),
  topic({
    id: 'manage-models',
    category: 'Settings',
    title: pair('Install and select local models', 'Установка и выбор локальных моделей'),
    summary: pair('Models provide local transcription, translation, polishing, planning, and review functions.', 'Модели обеспечивают локальную транскрибацию, перевод, полировку, планирование и проверку.'),
    steps: [
      pair('Open Settings and select Models.', 'Откройте Settings и выберите Models.'),
      pair('Use Download for a supported model, Locate for an existing model, or Scan to detect models on disk.', 'Используйте Download для поддерживаемой модели, Locate для существующей модели или Scan для поиска моделей на диске.'),
      pair('Select the required model in the relevant task section.', 'Выберите нужную модель в разделе соответствующей задачи.'),
      pair('Return to Config and confirm the model selections.', 'Вернитесь в Config и проверьте выбранные модели.'),
    ],
    troubleshooting: [
      pair('A removed or incomplete model cannot be used until it is downloaded or located again.', 'Удалённую или неполную модель нельзя использовать, пока она не будет загружена или найдена повторно.'),
    ],
    relatedTopicIDs: ['configure-engine', 'troubleshoot-unavailable'],
    keywords: ['models download locate scan whisper mlx модель скачать найти сканировать'],
  }),
  topic({
    id: 'process-media',
    category: 'Processing',
    screen: 'processing',
    title: pair('Process the selected media', 'Обработка выбранного медиа'),
    summary: pair('VaniScript splits the source into segments, transcribes them, and translates when requested.', 'VaniScript делит источник на сегменты, транскрибирует их и при необходимости переводит.'),
    steps: [
      pair('Start from Config with Initialize Engine.', 'Запустите обработку из Config кнопкой Initialize Engine.'),
      pair('Keep the app open while Processing shows progress.', 'Не закрывайте приложение, пока Processing показывает прогресс.'),
      pair('When Review opens, inspect each prepared segment.', 'После открытия Review проверьте каждый подготовленный сегмент.'),
    ],
    troubleshooting: [
      pair('For a failed segment, use Retry or reprocess only that segment from Review.', 'Для неудачного сегмента используйте Retry или повторно обработайте только этот сегмент в Review.'),
    ],
    relatedTopicIDs: ['review-transcript', 'manage-models'],
    keywords: ['processing progress transcribe segment retry обработка прогресс транскрибация повторить'],
  }),
  topic({
    id: 'review-transcript',
    category: 'Review',
    screen: 'review',
    title: pair('Review and approve segments', 'Проверка и утверждение сегментов'),
    summary: pair('Listen, compare, edit, and approve the source transcript and translation one segment at a time.', 'Прослушивайте, сравнивайте, редактируйте и утверждайте исходный текст и перевод по одному сегменту.'),
    steps: [
      pair('Use the audio bar to play and seek the current segment.', 'Используйте аудиопанель для воспроизведения и перемотки текущего сегмента.'),
      pair('Choose Source, Translation, or Dual view.', 'Выберите Source, Translation или Dual view.'),
      pair('Edit text or timed cues where necessary.', 'При необходимости исправьте текст или cues с таймингами.'),
      pair('Click Approve & Next. On the final segment, click Complete & Export.', 'Нажмите Approve & Next. На последнем сегменте нажмите Complete & Export.'),
    ],
    relatedTopicIDs: ['edit-cues', 'translate', 'glossary', 'export-documents'],
    keywords: ['review approve chunk segment dual source translation проверить утвердить сегмент'],
  }),
  topic({
    id: 'edit-cues',
    category: 'Review',
    screen: 'review',
    title: pair('Edit text and subtitle cues', 'Редактирование текста и subtitle cues'),
    summary: pair('Correct words, cue text, and cue timing while reviewing a segment.', 'Исправляйте слова, текст cues и их тайминги во время проверки сегмента.'),
    steps: [
      pair('Open the required segment in Review.', 'Откройте нужный сегмент в Review.'),
      pair('Edit the source or translated text directly, or open the timed cue editor.', 'Редактируйте исходный текст или перевод напрямую либо откройте редактор cues с таймингами.'),
      pair('Keep cue start and end times inside the segment and in chronological order.', 'Сохраняйте начало и конец cue внутри сегмента и в хронологическом порядке.'),
      pair('Listen again before approving the segment.', 'Прослушайте сегмент ещё раз перед утверждением.'),
    ],
    relatedTopicIDs: ['review-transcript', 'glossary'],
    keywords: ['cue timestamp subtitle edit timing text тайминг субтитры редактировать'],
  }),
  topic({
    id: 'translate',
    category: 'Translation',
    screen: 'review',
    title: pair('Create, switch, and polish translations', 'Создание, переключение и полировка переводов'),
    summary: pair('A project can keep multiple target-language translations and polish selected text.', 'Проект может хранить переводы на нескольких языках и полировать выбранный текст.'),
    steps: [
      pair('In Review, use the translation language control to select or add a language.', 'В Review используйте выбор языка перевода, чтобы выбрать или добавить язык.'),
      pair('Retry translation for a failed segment when needed.', 'При необходимости повторите перевод неудачного сегмента.'),
      pair('Use Polish for selected text or the current translation, then review the revision before approval.', 'Используйте Polish для выделенного текста или текущего перевода, затем проверьте результат перед утверждением.'),
    ],
    relatedTopicIDs: ['review-transcript', 'glossary', 'manage-models'],
    keywords: ['translate language polish retry перевод язык полировка повторить'],
  }),
  topic({
    id: 'glossary',
    category: 'Translation',
    title: pair('Use the glossary for names and terminology', 'Использование glossary для имён и терминов'),
    summary: pair('Store preferred spellings, variants, translations, categories, and notes for recurring terms.', 'Храните предпочтительные написания, варианты, переводы, категории и заметки для повторяющихся терминов.'),
    steps: [
      pair('Select a misspelled or inconsistent term in Review and choose Add to Glossary.', 'Выделите ошибочный или непоследовательный термин в Review и выберите Add to Glossary.'),
      pair('Add it as a variant of an existing term or create a new term.', 'Добавьте его как вариант существующего термина или создайте новый термин.'),
      pair('Open Settings > Glossary to edit, import, export, sort, or remove entries.', 'Откройте Settings > Glossary для редактирования, импорта, экспорта, сортировки или удаления записей.'),
      pair('Apply glossary corrections to the current chunk or the project, then review the changed text.', 'Примените исправления glossary к текущему чанку или проекту, затем проверьте изменённый текст.'),
    ],
    relatedTopicIDs: ['review-transcript', 'translate'],
    keywords: ['glossary term variant name spelling translation глоссарий термин имя вариант написание'],
  }),
  topic({
    id: 'export-documents',
    category: 'Export',
    screen: 'export',
    title: pair('Export transcript documents', 'Экспорт документов транскрипта'),
    summary: pair('Export original or translated content as TXT, SRT, VTT, or Markdown.', 'Экспортируйте исходный текст или перевод в TXT, SRT, VTT или Markdown.'),
    requirements: [
      pair('An active reviewed session. Translation exports require an active translation language.', 'Нужна активная проверенная сессия. Для экспорта перевода требуется выбранный язык перевода.'),
    ],
    steps: [
      pair('Open Export, or click Complete & Export after the last segment.', 'Откройте Export или нажмите Complete & Export после последнего сегмента.'),
      pair('In Document export, click the Original or Target button for the required format.', 'В Document export нажмите кнопку Original или Target нужного формата.'),
      pair('Choose the destination in the macOS save dialog.', 'Выберите папку назначения в системном окне сохранения macOS.'),
    ],
    relatedTopicIDs: ['review-transcript', 'create-shorts'],
    keywords: ['export txt srt vtt markdown subtitles document экспорт документ субтитры'],
  }),
  topic({
    id: 'create-shorts',
    category: 'Shorts',
    screen: 'export',
    title: pair('Find and export Shorts', 'Поиск и экспорт Shorts'),
    summary: pair('Find meaningful moments, choose clips, edit them, and export vertical videos or idea files.', 'Найдите содержательные моменты, выберите клипы, отредактируйте и экспортируйте вертикальные видео или файлы идей.'),
    steps: [
      pair('Open Export and scroll to Shorts & Reels.', 'Откройте Export и перейдите к Shorts & Reels.'),
      pair('Choose clip count and minimum/maximum length, then click a Find Moments language mode.', 'Укажите число клипов и минимальную/максимальную длину, затем выберите режим Find Moments.'),
      pair('Select clip cards. Use Details, Replace, Delete, or Edit when needed.', 'Выберите карточки клипов. При необходимости используйте Details, Replace, Delete или Edit.'),
      pair('Choose format, resolution, and frame rate.', 'Выберите формат, разрешение и частоту кадров.'),
      pair('Click Export ideas JSON/TXT or Export selected videos.', 'Нажмите Export ideas JSON/TXT или Export selected videos.'),
    ],
    troubleshooting: [
      pair('Target-language modes require an available project translation.', 'Для режимов на языке перевода в проекте должен быть доступен перевод.'),
    ],
    relatedTopicIDs: ['visual-editor', 'export-documents'],
    keywords: ['shorts reels find moments vertical clip export шортс рилс клип вертикальный'],
  }),
  topic({
    id: 'visual-editor',
    category: 'Shorts',
    screen: 'visualEditor',
    title: pair('Edit a Short in Visual Editor', 'Редактирование Short в Visual Editor'),
    summary: pair('Fine-tune framing, subtitles, timing, cuts, graphic layers, and extra audio before render.', 'Точно настройте кадрирование, субтитры, тайминг, cuts, графические слои и дополнительное аудио перед рендером.'),
    steps: [
      pair('On a Shorts card, click Edit.', 'На карточке Shorts нажмите Edit.'),
      pair('Adjust the clip timing and framing while checking the preview.', 'Настройте тайминг и кадрирование, проверяя preview.'),
      pair('Edit subtitle style and segments; add cuts, background, logo, intro/outro, text, or audio tracks as needed.', 'При необходимости измените стиль и сегменты субтитров; добавьте cuts, фон, логотип, intro/outro, текстовые или аудиодорожки.'),
      pair('Click Save, return to Export, select the clip, and render it.', 'Нажмите Save, вернитесь в Export, выберите клип и запустите рендер.'),
    ],
    relatedTopicIDs: ['create-shorts'],
    keywords: ['visual editor crop captions cuts logo intro outro text audio редактор кадр логотип титры'],
  }),
  topic({
    id: 'projects',
    category: 'Projects',
    title: pair('Open and manage saved projects', 'Открытие и управление сохранёнными проектами'),
    summary: pair('Resume previous work from the Projects panel and keep the active project saved.', 'Продолжайте предыдущую работу через панель Projects и сохраняйте активный проект.'),
    steps: [
      pair('In Review, click the folder button labelled Projects.', 'В Review нажмите кнопку с папкой Projects.'),
      pair('Choose a saved project to open it.', 'Выберите сохранённый проект для открытия.'),
      pair('Use the project actions to reveal the source, inspect media information, export a bundle, or delete a project.', 'Используйте действия проекта, чтобы показать источник, посмотреть сведения о медиа, экспортировать bundle или удалить проект.'),
      pair('Use + New Session when you want to leave the current workflow and start another source.', 'Используйте + New Session, чтобы выйти из текущего процесса и начать работу с другим источником.'),
    ],
    relatedTopicIDs: ['getting-started', 'export-documents'],
    keywords: ['projects saved open resume delete bundle проект открыть продолжить удалить'],
  }),
  topic({
    id: 'settings-agents',
    category: 'Settings',
    title: pair('Connect an MCP agent', 'Подключение MCP-агента'),
    summary: pair('Enable the local MCP server, choose the preferred agent, and use the generated setup instructions.', 'Включите локальный MCP-сервер, выберите предпочтительного агента и используйте созданные инструкции подключения.'),
    steps: [
      pair('Open Settings > Agents.', 'Откройте Settings > Agents.'),
      pair('Turn on Enable MCP.', 'Включите Enable MCP.'),
      pair('Turn on Allow Write Tools only when the agent may edit the active project.', 'Включайте Allow Write Tools только когда агенту разрешено изменять активный проект.'),
      pair('Choose Preferred Agent and use Copy Setup for that client.', 'Выберите Preferred Agent и используйте Copy Setup для этого клиента.'),
      pair('A green status means the client is currently connected; Active only selects the preferred profile.', 'Зелёный статус означает, что клиент сейчас подключён; Active только выбирает предпочтительный профиль.'),
    ],
    troubleshooting: [
      pair('If the status is Ready, the server is available but that external client is not currently connected.', 'Статус Ready означает, что сервер доступен, но внешний клиент сейчас не подключён.'),
    ],
    relatedTopicIDs: ['embedded-chat', 'troubleshoot-unavailable'],
    keywords: ['mcp codex agent connected ready enable write tools агент подключить статус'],
  }),
  topic({
    id: 'embedded-chat',
    category: 'Assistant',
    title: pair('Use the VaniScript AI Assistant', 'Использование VaniScript AI Assistant'),
    summary: pair('Ask how to use VaniScript, inspect the active project, or request an available MCP action directly in the app chat.', 'Задавайте вопросы по VaniScript, проверяйте активный проект или просите выполнить доступное MCP-действие прямо в чате приложения.'),
    steps: [
      pair('Open the AI Assistant panel.', 'Откройте панель AI Assistant.'),
      pair('Select MCP for the connected Codex route or API for the configured provider route.', 'Выберите MCP для подключённого Codex или API для настроенного провайдера.'),
      pair('Ask a concrete question, for example: How do I export SRT?', 'Задайте конкретный вопрос, например: Как экспортировать SRT?'),
      pair('For edits, enable Allow Write Tools in Settings > Agents and describe the intended change precisely.', 'Для изменений включите Allow Write Tools в Settings > Agents и точно опишите нужное действие.'),
    ],
    relatedTopicIDs: ['settings-agents', 'getting-started'],
    keywords: ['assistant chat help ask codex mcp api помощник чат спросить помощь'],
  }),
  topic({
    id: 'help-tour',
    category: 'Getting Started',
    title: pair('Open the visual Help Tour', 'Запуск визуального Help Tour'),
    summary: pair('The question-mark button highlights the important controls on the current workspace.', 'Кнопка со знаком вопроса подсвечивает важные элементы текущего рабочего экрана.'),
    steps: [
      pair('Open the workspace you want to learn.', 'Откройте рабочий экран, который хотите изучить.'),
      pair('Click the question-mark button with the Help Tour tooltip.', 'Нажмите кнопку со знаком вопроса и подсказкой Help Tour.'),
      pair('Follow Next through the highlighted controls, or close the tour at any time.', 'Переходите кнопкой Next по подсвеченным элементам или закройте экскурсию в любой момент.'),
    ],
    relatedTopicIDs: ['getting-started', 'embedded-chat'],
    keywords: ['help tour onboarding question mark walkthrough помощь обучение экскурсия знак вопроса'],
  }),
  topic({
    id: 'troubleshoot-unavailable',
    category: 'Troubleshooting',
    title: pair('Understand disabled or unavailable actions', 'Почему действие недоступно'),
    summary: pair('Most disabled actions are missing a source, session, translation, model, selection, permission, or active MCP connection.', 'Обычно действие недоступно из-за отсутствия источника, сессии, перевода, модели, выбора, разрешения или активного MCP-подключения.'),
    steps: [
      pair('Read the status message shown near the affected workspace.', 'Прочитайте сообщение статуса рядом с соответствующим рабочим экраном.'),
      pair('Confirm that a source and active session exist.', 'Убедитесь, что существуют исходный файл и активная сессия.'),
      pair('Check Settings > Models for required local models.', 'Проверьте нужные локальные модели в Settings > Models.'),
      pair('For translated or bilingual actions, select an available translation language.', 'Для перевода и двуязычных действий выберите доступный язык перевода.'),
      pair('For MCP edits, enable Allow Write Tools and confirm that the agent shows Connected.', 'Для MCP-изменений включите Allow Write Tools и убедитесь, что агент показывает Connected.'),
    ],
    relatedTopicIDs: ['manage-models', 'settings-agents', 'embedded-chat'],
    keywords: ['disabled unavailable error ready connected missing неактивно недоступно ошибка отсутствует'],
  }),
]);

function fallbackLanguage(value) {
  return typeof value === 'string' && value.trim().toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/** Normalize a BCP-47-like help locale to the canonical two-value set. */
function normalizeHelpLanguage(value, fallback = 'en') {
  const fallbackValue = fallbackLanguage(fallback);
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return fallbackValue;
  }
  if (typeof value !== 'string') return 'en';
  return value.trim().toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

function normalizeHelpScreen(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === 'alignment-editor' || raw === 'visual-editor' || raw.toLowerCase() === 'visualeditor') return 'visualEditor';
  const normalized = raw.toLowerCase();
  if (normalized === 'workspace' || normalized === '') return 'upload';
  if (HELP_SCREEN_VALUES.includes(raw)) return raw;
  if (HELP_SCREEN_VALUES.includes(normalized)) return normalized;
  return 'upload';
}

function clampedLimit(value) {
  const candidate = Number.isInteger(value) ? value : 5;
  return Math.max(1, Math.min(10, candidate));
}

function normalizedText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/gu)
    .filter(Boolean)
    .join(' ');
}

function tokens(value) {
  const normalized = normalizedText(value);
  return normalized ? normalized.split(' ') : [];
}

function localizedValue(value, language) {
  return value[language];
}

function localizeTopic(rawTopic, language) {
  return {
    id: rawTopic.id,
    category: rawTopic.category,
    screen: rawTopic.screen,
    title: localizedValue(rawTopic.title, language),
    summary: localizedValue(rawTopic.summary, language),
    requirements: rawTopic.requirements.map((item) => localizedValue(item, language)),
    steps: rawTopic.steps.map((item) => localizedValue(item, language)),
    troubleshooting: rawTopic.troubleshooting.map((item) => localizedValue(item, language)),
    relatedTopicIDs: [...rawTopic.relatedTopicIDs],
  };
}

function rawTopicFor(value) {
  if (typeof value === 'string') {
    const id = value.trim().toLowerCase();
    return HELP_TOPICS.find((entry) => entry.id.toLowerCase() === id) || null;
  }
  if (!value || typeof value !== 'object') return null;
  if (typeof value.id !== 'string') return null;
  const raw = HELP_TOPICS.find((entry) => entry.id === value.id);
  return raw || value;
}

function toLocalizedProjection(value, language) {
  const raw = rawTopicFor(value);
  if (!raw) return null;
  if (raw.title && typeof raw.title === 'object') return localizeTopic(raw, language);
  return cloneValue(raw);
}

/** Return localized summary fields for a topic without detail arrays. */
function getHelpTopicSummary(topicValue, language = 'en') {
  const localized = toLocalizedProjection(topicValue, normalizeHelpLanguage(language));
  if (!localized) return null;
  return {
    id: localized.id,
    category: localized.category,
    screen: localized.screen,
    title: localized.title,
    summary: localized.summary,
  };
}

/** Return the complete native-shaped localized topic projection. */
function toHelpTopicDictionary(topicValue, language = 'en') {
  return toLocalizedProjection(topicValue, normalizeHelpLanguage(language));
}

function listHelpTopics({ category, language } = {}) {
  const resolvedLanguage = normalizeHelpLanguage(language);
  const normalizedCategory = typeof category === 'string' ? category.trim().toLowerCase() : '';
  return HELP_TOPICS
    .filter((entry) => !normalizedCategory || entry.category.toLowerCase() === normalizedCategory)
    .map((entry) => localizeTopic(entry, resolvedLanguage));
}

function getHelpTopic({ id, language } = {}) {
  if (typeof id !== 'string' || id.trim() === '') return null;
  const normalizedID = id.trim().toLowerCase();
  const raw = HELP_TOPICS.find((entry) => entry.id.toLowerCase() === normalizedID);
  return raw ? localizeTopic(raw, normalizeHelpLanguage(language)) : null;
}

function searchHelp({ query, language, limit = 5 } = {}) {
  const resolvedLanguage = normalizeHelpLanguage(language);
  const normalizedQuery = normalizedText(query);
  const boundedLimit = clampedLimit(limit);
  if (!normalizedQuery) return listHelpTopics({ language: resolvedLanguage }).slice(0, boundedLimit);

  const queryTokens = new Set(tokens(normalizedQuery));
  const ranked = HELP_TOPICS.map((rawTopic) => {
    const localized = localizeTopic(rawTopic, resolvedLanguage);
    const secondary = localizeTopic(rawTopic, resolvedLanguage === 'en' ? 'ru' : 'en');
    const title = normalizedText(localized.title);
    const keywordTokens = new Set(tokens(rawTopic.keywords.join(' ')));
    const corpus = normalizedText([
      localized.title,
      localized.summary,
      localized.requirements.join(' '),
      localized.steps.join(' '),
      localized.troubleshooting.join(' '),
      secondary.title,
      secondary.summary,
      rawTopic.keywords.join(' '),
    ].join(' '));

    let score = 0;
    if (title === normalizedQuery) score += 1000;
    if (title.includes(normalizedQuery)) score += 300;
    if (corpus.includes(normalizedQuery)) score += 180;
    for (const token of queryTokens) {
      if (token.length <= 1) continue;
      if (keywordTokens.has(token)) score += 60;
      if (title.includes(token)) score += 30;
      if (corpus.includes(token)) score += 8;
    }
    return { rawTopic, score };
  })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || (left.rawTopic.id < right.rawTopic.id ? -1 : left.rawTopic.id > right.rawTopic.id ? 1 : 0));

  return ranked.slice(0, boundedLimit).map(({ rawTopic }) => localizeTopic(rawTopic, resolvedLanguage));
}

function contextualHelp({
  screen,
  hasSource = false,
  hasSession = false,
  processingProgress = 0,
  hasShortsPlans = false,
  language,
} = {}) {
  const resolvedLanguage = normalizeHelpLanguage(language);
  const canonicalScreen = normalizeHelpScreen(screen);
  const context = (title, summary, actions, recommendedTopicIDs) => ({
    screen: canonicalScreen,
    title: title[resolvedLanguage],
    summary: summary[resolvedLanguage],
    nextActions: actions.map((action) => action[resolvedLanguage]),
    recommendedTopicIDs: [...recommendedTopicIDs],
  });

  switch (canonicalScreen) {
    case 'config':
      return context(
        pair('Configure processing', 'Настройте обработку'),
        pair('Choose metadata, target language, transcription model, and translation model.', 'Выберите метаданные, язык перевода, модель транскрибации и модель перевода.'),
        [hasSource
          ? pair('Confirm the language and models, then click Initialize Engine.', 'Проверьте язык и модели, затем нажмите Initialize Engine.')
          : pair('Return to Upload and choose a source file first.', 'Вернитесь на Upload и сначала выберите исходный файл.')],
        ['configure-engine', 'manage-models', 'process-media'],
      );
    case 'processing': {
      const progress = Number.isFinite(processingProgress) ? processingProgress : 0;
      const percent = Math.trunc(Math.max(0, Math.min(1, progress)) * 100);
      return context(
        pair('Processing is running', 'Выполняется обработка'),
        pair(`VaniScript is preparing the transcript and translation. Current progress: ${percent}%.`, `VaniScript готовит транскрипт и перевод. Текущий прогресс: ${percent}%.`),
        [
          pair('Keep VaniScript open until Review appears.', 'Не закрывайте VaniScript до появления экрана Review.'),
          pair('If progress fails, open Settings > Models and verify the selected models.', 'Если обработка завершается ошибкой, откройте Settings > Models и проверьте выбранные модели.'),
        ],
        ['process-media', 'manage-models', 'troubleshoot-unavailable'],
      );
    }
    case 'review':
      return context(
        pair('Review and approve the transcript', 'Проверьте и утвердите транскрипт'),
        pair('Compare the source and translation, listen to the segment, edit cues, and approve completed work.', 'Сравнивайте исходный текст и перевод, слушайте сегмент, исправляйте cues и утверждайте готовый результат.'),
        [hasSession
          ? pair('Review the current segment, edit text if needed, then click Approve & Next.', 'Проверьте текущий сегмент, при необходимости исправьте текст и нажмите Approve & Next.')
          : pair('Start a session from Upload before using Review.', 'Перед работой в Review запустите сессию через Upload.'),
          pair('Use the view controls to show Source, Translation, or Dual mode.', 'Используйте переключатель вида для Source, Translation или Dual mode.')],
        hasSession ? ['review-transcript', 'edit-cues', 'translate', 'glossary'] : ['review-transcript'],
      );
    case 'export':
      return context(
        pair('Export documents or create Shorts', 'Экспортируйте документы или создайте Shorts'),
        pair('Export the reviewed transcript or generate and render short vertical clips.', 'Экспортируйте проверенный транскрипт или создайте и отрендерите короткие вертикальные клипы.'),
        [
          pair('Use Document export for TXT, SRT, VTT, or Markdown.', 'Используйте Document export для TXT, SRT, VTT или Markdown.'),
          hasShortsPlans
            ? pair('Select the required clip cards and export ideas or videos.', 'Выберите нужные карточки клипов и экспортируйте идеи или видео.')
            : pair('In Shorts & Reels, click Find Moments before selecting clips.', 'В разделе Shorts & Reels сначала нажмите Find Moments.'),
        ],
        ['export-documents', 'create-shorts', 'visual-editor'],
      );
    case 'visualEditor':
      return context(
        pair('Edit the selected clip', 'Отредактируйте выбранный клип'),
        pair('Adjust crop, timing, subtitles, cuts, background, logo, text, and audio layers.', 'Настройте кадрирование, тайминг, субтитры, cuts, фон, логотип, текстовые и аудиодорожки.'),
        [
          pair('Preview the clip after each timing or framing change.', 'Проверяйте preview после каждого изменения тайминга или кадрирования.'),
          pair('Click Save to keep the editor state, then return to Export to render.', 'Нажмите Save, чтобы сохранить состояние редактора, затем вернитесь в Export для рендера.'),
        ],
        ['visual-editor', 'create-shorts'],
      );
    case 'upload':
    default:
      return context(
        pair('Start with a source', 'Начните с исходного файла'),
        pair('Import a local recording, capture audio, or download media from a supported link.', 'Импортируйте локальную запись, запишите аудио или загрузите медиа по поддерживаемой ссылке.'),
        [
          pair('Click Upload Audio / Video for a file already on this Mac.', 'Нажмите Upload Audio / Video, если файл уже находится на этом Mac.'),
          pair('Use Record Audio Source for system audio or a microphone.', 'Используйте Record Audio Source для системного звука или микрофона.'),
          pair('Use Import Link for a supported internet media URL.', 'Используйте Import Link для поддерживаемой интернет-ссылки.'),
        ],
        ['getting-started', 'import-media', 'record-audio', 'import-link'],
      );
  }
}

const CHECKLIST = deepFreeze({
  title: pair('First project checklist', 'Чек-лист первого проекта'),
  summary: pair('Follow this route from an empty workspace to a reviewed export.', 'Следуйте этому маршруту от пустого рабочего пространства до проверенного экспорта.'),
  steps: [
    pair('Open Settings > Models and confirm that the required transcription and translation models are ready.', 'Откройте Settings > Models и убедитесь, что нужные модели транскрибации и перевода готовы.'),
    pair('On Upload, choose Upload Audio / Video, Record Audio Source, or Import Link.', 'На экране Upload выберите Upload Audio / Video, Record Audio Source или Import Link.'),
    pair('On Config, verify metadata, Target Language, Transcription Model, and Translation Model.', 'На экране Config проверьте метаданные, Target Language, Transcription Model и Translation Model.'),
    pair('Click Initialize Engine and wait for Review.', 'Нажмите Initialize Engine и дождитесь Review.'),
    pair('In Review, listen to each segment, correct the source or translation, and click Approve & Next.', 'В Review прослушивайте каждый сегмент, исправляйте исходный текст или перевод и нажимайте Approve & Next.'),
    pair('Use glossary actions for recurring names and specialist terms.', 'Используйте glossary для повторяющихся имён и специальных терминов.'),
    pair('After the last segment, open Export and choose a document format or create Shorts.', 'После последнего сегмента откройте Export и выберите формат документа или создайте Shorts.'),
    pair('Use the question-mark Help Tour button on any main screen for a visual walkthrough.', 'На любом основном экране нажмите кнопку со знаком вопроса Help Tour для визуальной экскурсии.'),
  ],
  topicIDs: ['getting-started', 'manage-models', 'configure-engine', 'review-transcript', 'glossary', 'export-documents', 'create-shorts'],
});

function onboardingChecklist({ language } = {}) {
  const resolvedLanguage = normalizeHelpLanguage(language);
  return {
    title: CHECKLIST.title[resolvedLanguage],
    summary: CHECKLIST.summary[resolvedLanguage],
    steps: CHECKLIST.steps.map((step) => step[resolvedLanguage]),
    topicIDs: [...CHECKLIST.topicIDs],
  };
}

function tourStep(screen, index, topicId, topicStep, targetSelector, arrowCurveOffset, bubblePlacement) {
  return {
    id: `${screen}-${index + 1}`,
    topicId,
    stepIndex: index,
    topicStep,
    targetSelector,
    arrowCurveOffset: { ...arrowCurveOffset },
    bubblePlacement,
  };
}

const HELP_TOUR_DEFINITIONS = deepFreeze({
  upload: {
    screen: 'upload',
    steps: [
      tourStep('upload', 0, 'settings-agents', 0, '[data-tour="settings-btn"]', { dx: -30, dy: 40 }, 'left'),
      tourStep('upload', 1, 'import-media', 1, '[data-tour="workspace-dropzone"]', { dx: 40, dy: -30 }, 'bottom'),
      tourStep('upload', 2, 'record-audio', 0, '[data-tour="workspace-record-card"]', { dx: 0, dy: -60 }, 'bottom'),
      tourStep('upload', 3, 'import-link', 0, '[data-tour="workspace-link-card"]', { dx: -40, dy: -30 }, 'bottom'),
    ],
  },
  config: {
    screen: 'config',
    steps: [
      tourStep('config', 0, 'configure-engine', 0, '[data-tour="config-metadata"]', { dx: 60, dy: 20 }, 'right'),
      tourStep('config', 1, 'configure-engine', 1, '[data-tour="target-lang-select"]', { dx: -50, dy: -40 }, 'top'),
      tourStep('config', 2, 'manage-models', 2, '[data-tour="transcription-model-select"]', { dx: 50, dy: -40 }, 'top'),
      tourStep('config', 3, 'configure-engine', 3, '[data-tour="start-engine-btn"]', { dx: -40, dy: -60 }, 'top'),
    ],
  },
  review: {
    screen: 'review',
    steps: [
      tourStep('review', 0, 'review-transcript', 0, '[data-tour="review-audio-bar"]', { dx: 30, dy: 60 }, 'bottom'),
      tourStep('review', 1, 'edit-cues', 1, '[data-tour="review-pane-original"]', { dx: 60, dy: 40 }, 'right'),
      tourStep('review', 2, 'review-transcript', 1, '[data-tour="review-pane-translation"]', { dx: -60, dy: 40 }, 'left'),
      tourStep('review', 3, 'translate', 2, '[data-tour="review-editing-model"]', { dx: 20, dy: 50 }, 'bottom'),
      tourStep('review', 4, 'review-transcript', 1, '[data-tour="review-view-group"]', { dx: 30, dy: 50 }, 'bottom'),
      tourStep('review', 5, 'review-transcript', 0, '[data-tour="previous-segment-btn"]', { dx: -30, dy: -50 }, 'top'),
      tourStep('review', 6, 'review-transcript', 3, '[data-tour="approve-next-btn"]', { dx: -40, dy: -60 }, 'top'),
    ],
  },
  export: {
    screen: 'export',
    steps: [
      tourStep('export', 0, 'export-documents', 0, '[data-tour="export-documents"]', { dx: 50, dy: 40 }, 'bottom'),
      tourStep('export', 1, 'create-shorts', 1, '[data-tour="shorts-find-moments"]', { dx: 40, dy: -40 }, 'bottom'),
      tourStep('export', 2, 'create-shorts', 2, '[data-tour="shorts-choose-clips"]', { dx: -50, dy: 30 }, 'left'),
      tourStep('export', 3, 'visual-editor', 0, '[data-tour="shorts-edit-clip"]', { dx: -30, dy: 40 }, 'left'),
      tourStep('export', 4, 'create-shorts', 3, '[data-tour="shorts-export-settings"]', { dx: 40, dy: -30 }, 'top'),
      tourStep('export', 5, 'create-shorts', 4, '[data-tour="shorts-export-actions"]', { dx: -40, dy: 30 }, 'top'),
      tourStep('export', 6, 'export-documents', 2, '[data-tour="export-footer-actions"]', { dx: 0, dy: -40 }, 'top'),
    ],
  },
  settings: {
    screen: 'settings',
    steps: [
      tourStep('settings', 0, 'embedded-chat', 1, '[data-tour="settings-tab-0"]', { dx: -20, dy: 40 }, 'bottom'),
      tourStep('settings', 1, 'manage-models', 0, '[data-tour="settings-tab-1"]', { dx: -20, dy: 40 }, 'bottom'),
      tourStep('settings', 2, 'help-tour', null, '[data-tour="settings-tab-2"]', { dx: -20, dy: 40 }, 'bottom'),
      tourStep('settings', 3, 'glossary', 2, '[data-tour="settings-tab-3"]', { dx: -20, dy: 40 }, 'bottom'),
      tourStep('settings', 4, 'configure-engine', null, '[data-tour="settings-tab-4"]', { dx: -20, dy: 40 }, 'bottom'),
      tourStep('settings', 5, 'configure-engine', 2, '[data-tour="settings-tab-5"]', { dx: -20, dy: 40 }, 'bottom'),
      tourStep('settings', 6, 'configure-engine', null, '[data-tour="settings-tab-6"]', { dx: -20, dy: 40 }, 'bottom'),
      tourStep('settings', 7, 'settings-agents', 0, '[data-tour="settings-tab-7"]', { dx: -20, dy: 40 }, 'bottom'),
      tourStep('settings', 8, 'troubleshoot-unavailable', 0, '[data-tour="settings-tab-8"]', { dx: -20, dy: 40 }, 'bottom'),
    ],
  },
  visualEditor: {
    screen: 'visualEditor',
    steps: [
      tourStep('visualEditor', 0, 'visual-editor', 2, '.alignment-lang-toggle', { dx: -30, dy: 40 }, 'bottom'),
      tourStep('visualEditor', 1, 'visual-editor', 1, '.btn-dl-sync', { dx: -30, dy: 40 }, 'bottom'),
      tourStep('visualEditor', 2, 'visual-editor', 1, '.alignment-preview', { dx: 40, dy: -30 }, 'bottom'),
      tourStep('visualEditor', 3, 'visual-editor', 2, '.alignment-multitrack', { dx: 0, dy: -60 }, 'top'),
      tourStep('visualEditor', 4, 'visual-editor', 2, '.alignment-right', { dx: -60, dy: 40 }, 'left'),
      tourStep('visualEditor', 5, 'visual-editor', 3, '.alignment-save-btn', { dx: -40, dy: 40 }, 'bottom'),
    ],
  },
});

function getHelpTourDefinition(screen) {
  const canonical = screen === 'alignment-editor' ? 'visualEditor' : screen;
  const definition = HELP_TOUR_DEFINITIONS[canonical];
  return definition ? cloneValue(definition) : null;
}

const HELP_UI_COPY = deepFreeze({
  en: {
    search: 'Search',
    currentScreen: 'Current screen',
    checklist: 'Checklist',
    back: 'Back',
    close: 'Close',
    startHelpTour: 'Start Help Tour',
    english: 'English',
    russian: 'Russian',
    noResults: 'No results',
    topicUnavailable: 'Topic unavailable',
    next: 'Next',
    previous: 'Previous',
    finish: 'Finish',
    skipWalkthrough: 'Skip walkthrough',
    step: 'Step',
    helpTour: 'Help Tour',
  },
  ru: {
    search: 'Поиск',
    currentScreen: 'Текущий экран',
    checklist: 'Чек-лист',
    back: 'Назад',
    close: 'Закрыть',
    startHelpTour: 'Запустить Help Tour',
    english: 'Английский',
    russian: 'Русский',
    noResults: 'Ничего не найдено',
    topicUnavailable: 'Тема недоступна',
    next: 'Далее',
    previous: 'Назад',
    finish: 'Готово',
    skipWalkthrough: 'Пропустить экскурсию',
    step: 'Шаг',
    helpTour: 'Help Tour',
  },
});

if (typeof module !== 'undefined') {
  module.exports = {
    HELP_LANGUAGE_VALUES,
    HELP_SCREEN_VALUES,
    HELP_TOUR_DEFINITIONS,
    HELP_UI_COPY,
    normalizeHelpLanguage,
    normalizeHelpScreen,
    listHelpTopics,
    getHelpTopic,
    getHelpTopicSummary,
    toHelpTopicDictionary,
    searchHelp,
    contextualHelp,
    onboardingChecklist,
    getHelpTourDefinition,
  };
}
