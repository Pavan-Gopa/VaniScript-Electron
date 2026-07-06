import { GlossaryEntry } from '../types';

type StarterTerm = readonly [source: string, translation: string, category: string, variants: readonly string[]];

const STARTER_CREATED_AT = '2026-05-08T00:00:00.000Z';

const CATEGORY_LABELS: Record<string, string> = {
  'Ачарьи / Учители': 'Acharyas / Teachers',
  'Аватары / Господь': 'Avataras / Lord',
  'Имена Бога': 'Names of God',
  'Мантры': 'Mantras',
  'Священные писания': 'Scriptures',
  'Философские термины': 'Philosophical terms',
  'Практики': 'Practices',
  'Священные объекты': 'Sacred objects',
  'Священные места': 'Sacred places',
  'Священные личности': 'Sacred personalities',
  'Организации': 'Organizations',
  'Пользовательское': 'Custom',
};

const TERMS: StarterTerm[] = [
  ['Śrīla Prabhupāda', 'Шрила Прабхупада', 'Ачарьи / Учители', ['Srila Prabhupada', 'Shila Prabhupada', 'Shrila Prabhupada', 'Srila Prabhupad', 'Shri La Prabhupada']],
  ['Bhaktivinoda Ṭhākura', 'Бхактивинода Тхакур', 'Ачарьи / Учители', ['Bhaktivinoda Thakur', 'Bhakti Vinoda Thakur', 'Bhakti Vinod Takur', 'Bhaktivinoda Thakura']],
  ['Śrī Caitanya Mahāprabhu', 'Шри Чайтанья Махапрабху', 'Аватары / Господь', ['Chaitanya Mahaprabhu', 'Chitanya Mahaprabhu', 'Chetanya Mahaprabhu', 'Sri Chaitanya', 'Chatanya']],
  ['Matsya Avatāra', 'Матсья-аватара', 'Аватары / Господь', ['Matsya Avatar', 'Matsyavatar', 'Matsya Avatara', 'Matsyaavatar', 'Matsa Avatar', 'Matsia Avatar', 'Matsya avatār']],
  ['Kūrma Avatāra', 'Курма-аватара', 'Аватары / Господь', ['Kurma Avatar', 'Kurma Avatara', 'Kurmavatar', 'Koorma Avatar', 'Kurma avatār']],
  ['Varāha Avatāra', 'Вараха-аватара', 'Аватары / Господь', ['Varaha Avatar', 'Varaha Avatara', 'Varahavatar', 'Varaha avatār']],
  ['Nṛsiṁha Avatāra', 'Нрисимха-аватара', 'Аватары / Господь', ['Nrsimha Avatar', 'Narasimha Avatar', 'Nrisingha Avatar', 'Nrisimha Avatara', 'Narsingh Avatar', 'Narasimhadev']],
  ['Vāmana Avatāra', 'Вамана-аватара', 'Аватары / Господь', ['Vamana Avatar', 'Vamana Avatara', 'Vamanadev', 'Vaman Avatar']],
  ['Jayapatākā Swami', 'Джаяпатака Свами', 'Ачарьи / Учители', ['Jayapataka Swami', 'Jayapataka Maharaj', 'Jaipataka Maharaja', 'Jipataka Maharaj']],
  ['Kṛṣṇa', 'Кришна', 'Имена Бога', ['Krsna', 'Krushna', 'Krishnaa', 'Krisna']],
  ['Rādhā / Rādhārāṇī', 'Радха / Радхарани', 'Имена Бога', ['Radha', 'Raadha', 'Radhe', 'Radharani', 'Radha rani']],
  ['Hare Kṛṣṇa', 'Харе Кришна', 'Мантры', ['Hari Krishna', 'Harry Krishna', 'Harekrishna']],
  ['Mahā-mantra', 'Маха-мантра', 'Мантры', ['Mahamantra', 'Maha mantra', 'Maha-mantra']],
  ['Bhagavad-gītā', 'Бхагавад-гита', 'Священные писания', ['Bhagavad Gita', 'Bhagwad Gita', 'Bhagavad-Gita', 'Bhagwad Geeta']],
  ['Śrīmad-Bhāgavatam', 'Шримад-Бхагаватам', 'Священные писания', ['Srimad Bhagavatam', 'Shrimad Bhagavatam', 'Srimad-Bhagavatam', 'Bhagavatam']],
  ['Caitanya-caritāmṛta', 'Чайтанья-чаритамрита', 'Священные писания', ['Chaitanya Charitamrita', 'Chaitanya Charitramrita', 'Caitanya Caritamrta']],
  ['bhakti', 'бхакти', 'Философские термины', ['Bhakthee', 'Bakhti', 'Bhakhti']],
  ['prema', 'према', 'Философские термины', ['Prema bhakti', 'Prem', 'Preema']],
  ['Vaiṣṇava / Vaiṣṇavism', 'Вайшнав / Вайшнавизм', 'Философские термины', ['Vaishnavas', 'Vaisnavism', 'Vaishnavism', 'Vaishnava']],
  ['saṅkīrtana', 'санкиртана', 'Практики', ['Sankirtan', 'Sankeertana', 'Sankirtana']],
  ['japa', 'джапа', 'Практики', ['Jappa', 'Jap', 'Jaapa']],
  ['Tulasī', 'Туласи', 'Священные объекты', ['Tulsi', 'Thulsi', 'Toolasi', 'Tulsii']],
  ['Viṣṇu', 'Вишну', 'Имена Бога', ['Vishnu', 'Visnu', 'Vishno', 'Visno']],
  ['Nārāyaṇa', 'Нараяна', 'Имена Бога', ['Narayan', 'Naarayana', 'Narayana']],
  ['guru', 'гуру', 'Ачарьи / Учители', ['Gurudev', 'Guroo', 'Guru dev']],
  ['guru-paramparā', 'гуру-парампара', 'Философские термины', ['Guru Parampara', 'Guru-parampara', 'Parampara']],
  ['Vṛndāvana', 'Вриндаван', 'Священные места', ['Vrindavan', 'Vrindavana', 'Vrindaban', 'Brindavan']],
  ['Māyāpur', 'Майяпур', 'Священные места', ['Mayapur', 'Mayapura', 'Maapur', 'Maya pur']],
  ['Navadvīpa', 'Навадвипа', 'Священные места', ['Navadwip', 'Navadvipa', 'Nabadwip', 'Nabadweep']],
  ['Jagannātha', 'Джаганнатха', 'Имена Бога', ['Jagannath', 'Jaganath', 'Jaganaath', 'Jaggannatha']],
  ['Balarāma', 'Баларама', 'Имена Бога', ['Balarama', 'Balaram', 'Balaraama', 'Bal Ram']],
  ['Subhadrā', 'Субхадра', 'Имена Бога', ['Subhadra', 'Subhradra', 'Subhadra devi']],
  ['Nityānanda', 'Нитьянанда', 'Аватары / Господь', ['Nityananda', 'Nityananda Prabhu', 'Nityananada', 'Nitaiyananda']],
  ['Advaita Ācārya', 'Адвайта Ачарья', 'Аватары / Господь', ['Advaita Acharya', 'Advaita Acarya', 'Advaita acharyaa']],
  ['Rūpa Gosvāmī', 'Рупа Госвами', 'Ачарьи / Учители', ['Rupa Goswami', 'Rupa Gosvami', 'Roopa Goswami']],
  ['Sanātana Gosvāmī', 'Санатана Госвами', 'Ачарьи / Учители', ['Sanatana Goswami', 'Sanatan Gosvami', 'Sanatana Gosvami']],
  ['Raghunātha Dāsa Gosvāmī', 'Рагхунатха Дас Госвами', 'Ачарьи / Учители', ['Raghunatha Dasa', 'Ragunath Das', 'Raghunath Das Goswami']],
  ['Jīva Gosvāmī', 'Джива Госвами', 'Ачарьи / Учители', ['Jiva Goswami', 'Jeeva Gosvami', 'Jiva Gosvami']],
  ['Bhaktisiddhānta Sarasvatī Ṭhākura', 'Бхактисиддханта Сарасвати Тхакур', 'Ачарьи / Учители', ['Bhaktisiddhanta Saraswati', 'Bhaktisiddhanta Thakur', 'Bhakti Siddhanta Saraswati']],
  ['Mādhavendra Purī', 'Мадхавендра Пури', 'Ачарьи / Учители', ['Madhavendra Puri', 'Madhav Puri', 'Madhavendra']],
  ['Īśvara Purī', 'Ишвара Пури', 'Ачарьи / Учители', ['Ishvara Puri', 'Isvarapuri', 'Ishwara Puri']],
  ['Mahā-Viṣṇu', 'Маха-Вишну', 'Имена Бога', ['Maha Vishnu', 'Maha-Vishnu', 'Mahavishnu']],
  ['Paramātmā', 'Параматма', 'Философские термины', ['Paramatma', 'Paramatman', 'Paramathma']],
  ['Brahman', 'Брахман', 'Философские термины', ['Brahmaan', 'Brahm', 'Brahmana']],
  ['māyā', 'майя', 'Философские термины', ['Maaya', 'Maia', 'Mayaa']],
  ['līlā', 'лила', 'Философские термины', ['Lila', 'Leela', 'Liila', 'Leelaa']],
  ['dharma', 'дхарма', 'Философские термины', ['Dharm', 'Dharma dharma', 'Dharmaa']],
  ['karma', 'карма', 'Философские термины', ['Karm', 'Karmaa', 'Karma karma']],
  ['saṁsāra', 'самсара', 'Философские термины', ['Samsara', 'Samsaara', 'Sansar']],
  ['mokṣa', 'мокша', 'Философские термины', ['Moksha', 'Moksh', 'Mooksha']],
  ['mukti', 'мукти', 'Философские термины', ['Mukthi', 'Mokti', 'Muktee']],
  ['ācārya', 'ачарья', 'Ачарьи / Учители', ['Acharya', 'Acarya', 'Acharyaa']],
  ['Svāmī', 'Свами', 'Ачарьи / Учители', ['Swami', 'Swamee', 'Svami']],
  ['Mahārāja', 'Махараджа', 'Ачарьи / Учители', ['Maharaj', 'Mahaaraj', 'Maharaaj']],
  ['Prabhu', 'Прабху', 'Ачарьи / Учители', ['Prabho', 'Praboo', 'Prabhoo']],
  ['Vaikuṇṭha', 'Вайкунтха', 'Священные места', ['Vaikuntha', 'Vaikunta', 'Vaikunth']],
  ['Goloka Vṛndāvana', 'Голока Вриндавана', 'Священные места', ['Goloka', 'Goloka Vrindavan', 'Gauloka']],
  ['Mathurā', 'Матхура', 'Священные места', ['Mathura', 'Mathoora', 'Mathuraa']],
  ['Dvārakā', 'Дварака', 'Священные места', ['Dvaraka', 'Dwarka', 'Dwaraka']],
  ['pūjā', 'пуджа', 'Практики', ['Puja', 'Pooja', 'Pujaa']],
  ['āratī', 'арати', 'Практики', ['Arati', 'Aarti', 'Arthi', 'Aarati']],
  ['maṅgala-āratī', 'мангала-арати', 'Практики', ['Mangala arati', 'Mangala-arati', 'Mongal arati']],
  ['prasādam', 'прасадам', 'Священные объекты', ['Prasad', 'Prashad', 'Prasaad', 'Prasaadam']],
  ['tilaka', 'тилака', 'Священные объекты', ['Tilak', 'Tilaak', 'Teelak']],
  ['Śālagrāma', 'Шалаграма', 'Священные объекты', ['Shaligram', 'Shalagrama', 'Shalagram']],
  ['mṛdaṅga', 'мриданга', 'Священные объекты', ['Mridanga', 'Mridangam', 'Mrudanga']],
  ['kartāla', 'карталы', 'Священные объекты', ['Kartals', 'Kartala', 'Kartal']],
  ['kīrtana', 'киртан', 'Практики', ['Kirtana', 'Kirtan', 'Kiirtan', 'Keertana']],
  ['sādhu', 'садху', 'Философские термины', ['Sadhu', 'Saadhu', 'Sadhu sanga']],
  ['śāstra', 'шастра', 'Священные писания', ['Shastra', 'Sastra', 'Shaastras']],
  ['Vedānta', 'Веданта', 'Священные писания', ['Vedanta', 'Vedaanta', 'Vedanta Sutra']],
  ['Upaniṣad', 'Упанишада', 'Священные писания', ['Upanishad', 'Upanishads', 'Upnishad']],
  ['Veda / Vedas', 'Веды', 'Священные писания', ['Vedas', 'Veedas', 'Vedaas']],
  ['harināma', 'харинама', 'Практики', ['Harinama', 'Harinam', 'Hari nama']],
  ['nāma-haṭṭa', 'нама-хатта', 'Организации', ['Nama hatta', 'Nama-hatta', 'Namahatta']],
  ['ISKCON', 'ИСККОН', 'Организации', ['Iskon', 'Iskcon', 'Isckon']],
  ['Gauḍīya Maṭha', 'Гаудия Матха', 'Организации', ['Gaudiya Math', 'Gaudiya Matha', 'Gaudia Math']],
  ['Gauḍīya Vaiṣṇavism', 'Гаудия-вайшнавизм', 'Философские термины', ['Gaudiya Vaishnavism', 'Gaudiya Vaishnavas', 'Gaudia Vaishnavism']],
  ['acintya-bhedābheda', 'ачинтья-бхедабхеда', 'Философские термины', ['Achintya Bhedabheda', 'Achintya bhedabheda', 'Acintya Bheda Abheda']],
  ['pañca-tattva', 'панча-таттва', 'Аватары / Господь', ['Pancha tattva', 'Pancha-tattva', 'Panca tattva']],
  ['Govinda', 'Говинда', 'Имена Бога', ['Govindaa', 'Govind', 'Goovinda']],
  ['Gopāla', 'Гопала', 'Имена Бога', ['Gopala', 'Gopal', 'Goopal']],
  ['gopī', 'гопи', 'Философские термины', ['Gopis', 'Gopees', 'Gopii']],
  ['Nanda Mahārāja', 'Нанда Махараджа', 'Священные личности', ['Nanda Maharaja', 'Nanda Maharaj', 'Nand Maharaj']],
  ['Yaśodā', 'Яшода', 'Священные личности', ['Yashoda', 'Yasoda', 'Yashoda maa']],
  ['Devakī', 'Деваки', 'Священные личности', ['Devaki', 'Devakee', 'Devakii']],
  ['sādhana', 'садхана', 'Практики', ['Sadhana', 'Saadhanaa', 'Sadhan']],
  ['sādhana-bhakti', 'садхана-бхакти', 'Практики', ['Sadhana Bhakti', 'Sadhana-bhakti', 'Sadhanabhakti']],
  ['vaidhī-bhakti', 'вайдхи-бхакти', 'Практики', ['Vaidhi Bhakti', 'Vaidhi-bhakti', 'Vaidhabhakti']],
  ['rāgānugā-bhakti', 'раганугабхакти', 'Практики', ['Raganuga Bhakti', 'Raganuga-bhakti', 'Raganugabhakti']],
  ['nava-vidha bhakti', 'нававидха-бхакти', 'Практики', ['Navavidha Bhakti', 'Nine processes of bhakti', 'Nava-vidha']],
  ['śravaṇam', 'шраванам', 'Практики', ['Shravanam', 'Shravana', 'Sravanam']],
  ['kīrtanam', 'киртанам', 'Практики', ['Kirtanam', 'Kirtana', 'Keertanam']],
  ['smaraṇam', 'смаранам', 'Практики', ['Smaranam', 'Smarana', 'Smarnam']],
  ['pāda-sevanam', 'пада-севанам', 'Практики', ['Pada sevanam', 'Padasevana', 'Pada-sevanam']],
  ['arcanam', 'арчанам', 'Практики', ['Archanam', 'Archana', 'Arcanam']],
  ['vandanam', 'ванданам', 'Практики', ['Vandanam', 'Vandana', 'Vandam']],
  ['dāsyam', 'дасьям', 'Практики', ['Dasyam', 'Dasya', 'Dashyam']],
  ['sakhyam', 'сакхьям', 'Практики', ['Sakhyam', 'Sakhya', 'Sakheeyam']],
  ['ātma-nivedanam', 'атма-ниведанам', 'Практики', ['Atma nivedanam', 'Atma-nivedanam', 'Atmanivedanam']],
  ['anarthas', 'анартхи', 'Философские термины', ['Anartha', 'Anarthaas']],
  ['arcana', 'арчана', 'Практики', ['Archana', 'Archana puja', 'Archanaa']],
  ['Svarūpa Dāmodara', 'Сварупа Дамодара', 'Ачарьи / Учители', ['Svarupa Damodara', 'Svarup Damodar', 'Swarupa Damodar']],
  ['Vāsudeva Datta', 'Васудева Датта', 'Ачарьи / Учители', ['Vasudeva Datta', 'Vasudeva Datta Thakur', 'Vasudev Datta']],
  ['Śrīmatī', 'Шримати', 'Имена Бога', ['Srimati', 'Srimathi', 'Shrimati']],
];

function slug(value: string): string {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[ṛṚ]/g, 'r').replace(/[ṣṢśŚ]/g, 's').replace(/[ṭṬ]/g, 't').replace(/[ḍḌ]/g, 'd').replace(/[ṅṄ]/g, 'n').replace(/[ñÑ]/g, 'n').replace(/[ṁṀṃ]/g, 'm').replace(/[īĪ]/g, 'i').replace(/[āĀ]/g, 'a').replace(/[ūŪ]/g, 'u');
}

function expandVariants(source: string, variants: readonly string[]): string[] {
  const base = [source, stripDiacritics(source), ...variants];
  const expanded = new Set<string>();
  for (const variant of base) {
    const clean = variant.trim();
    if (!clean) continue;
    expanded.add(clean);
    expanded.add(clean.replace(/\s*\/\s*/g, ' '));
    expanded.add(clean.replace(/-/g, ' '));
    expanded.add(clean.replace(/\s+/g, '-'));
    expanded.add(clean.replace(/\bSri\b/g, 'Shri'));
    expanded.add(clean.replace(/\bShri\b/g, 'Sri'));
    expanded.add(clean.replace(/\bThakur\b/g, 'Takur'));
    expanded.add(clean.replace(/\bGoswami\b/g, 'Gosvami'));
    expanded.add(clean.replace(/\bMaharaja\b/g, 'Maharaj'));
  }
  expanded.delete(source);
  return Array.from(expanded).filter(Boolean).sort((a, b) => b.length - a.length);
}

export function normalizeGlossaryCategory(category: string | undefined): string | undefined {
  const trimmed = category?.trim();
  if (!trimmed) return undefined;
  return CATEGORY_LABELS[trimmed] ?? trimmed;
}

export const STARTER_GLOSSARY: GlossaryEntry[] = TERMS.map(([source, translation, category, variants]) => ({
  id: `starter-vaishnava-${slug(source)}`,
  variants: expandVariants(source, variants),
  source,
  translation,
  category: normalizeGlossaryCategory(category),
  translations: {
    Russian: translation,
    Default: translation,
  },
  remember: true,
  createdAt: STARTER_CREATED_AT,
  updatedAt: STARTER_CREATED_AT,
}));

export function mergeStarterGlossary(entries: GlossaryEntry[] = []): GlossaryEntry[] {
  const existingIds = new Set(entries.map((entry) => entry.id));
  const existingSources = new Set(entries.map((entry) => entry.source.trim().toLowerCase()).filter(Boolean));
  const missing = STARTER_GLOSSARY.filter((entry) => !existingIds.has(entry.id) && !existingSources.has(entry.source.trim().toLowerCase()));
  return [...entries, ...missing];
}
