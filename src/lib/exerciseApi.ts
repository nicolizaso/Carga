import type { Exercise } from '../types';

/*
 * Catálogo remoto de ejercicios armado con varias fuentes. Cada fuente sabe bajar su
 * catálogo y traducirlo al modelo interno; `fetchExercises` las consulta en paralelo y
 * junta los resultados sin duplicados. Para sumar otra API alcanza con escribir su
 * `ExerciseSource` y agregarla a `SOURCES`.
 */

interface ExerciseSource {
  id: string;
  /** Devuelve el catálogo completo ya normalizado. Puede lanzar si la fuente no responde. */
  fetchAll: () => Promise<Exercise[]>;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/* ------------------------------------------------------------------------------------ */
/* free-exercise-db                                                                      */
/* ------------------------------------------------------------------------------------ */

// CDNs de alta disponibilidad ordenados por confiabilidad
const FREE_EXERCISE_DB_ENDPOINTS = [
  'https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@main/dist/exercises.json',
  'https://cdn.statically.io/gh/yuhonas/free-exercise-db/main/dist/exercises.json',
  'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json',
  '/exercises.json', // Fallback local dentro de public/
];

const BASE_CDN_URL = 'https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@main/exercises/';

// Mapeo de primaryMuscles / bodyPart a categorías en español
const MUSCLE_GROUP_TRANSLATIONS: Record<string, string> = {
  abdominals: 'Core',
  chest: 'Pecho',
  lats: 'Espalda',
  'lower back': 'Espalda',
  'middle back': 'Espalda',
  traps: 'Espalda',
  neck: 'Espalda',
  shoulders: 'Hombros',
  biceps: 'Bíceps',
  triceps: 'Tríceps',
  forearms: 'Bíceps',
  quadriceps: 'Piernas',
  hamstrings: 'Piernas',
  calves: 'Piernas',
  glutes: 'Piernas',
  adductors: 'Piernas',
  abductors: 'Piernas',
  // Fallbacks para estructuras alternativas
  back: 'Espalda',
  legs: 'Piernas',
  core: 'Core',
  abs: 'Core',
  cardio: 'Cardio',
};

const EQUIPMENT_TRANSLATIONS: Record<string, string> = {
  dumbbell: 'Mancuerna',
  barbell: 'Barra',
  machine: 'Máquina',
  cable: 'Polea',
  'body weight': 'Peso Corporal',
  bodyweight: 'Peso Corporal',
  assisted: 'Máquina',
  band: 'Otro',
  kettlebell: 'Otro',
  'leverage machine': 'Máquina',
  'medicine ball': 'Otro',
  'stability ball': 'Otro',
  'smith machine': 'Máquina',
};

export interface RemoteExercise {
  id: string;
  name: string;
  bodyPart?: string;
  target?: string;
  primaryMuscles?: string[];
  equipment?: string;
  gifUrl?: string;
  images?: string[];
  instructions?: string[];
}

/**
 * Petición con reintentos automáticos en mirrors de CDN.
 */
async function fetchWithFallback(): Promise<RemoteExercise[]> {
  for (const url of FREE_EXERCISE_DB_ENDPOINTS) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
    } catch {
      console.warn(`[ExerciseAPI] Falló la conexión con ${url}`);
    }
  }
  throw new Error('Todos los endpoints de free-exercise-db fallaron.');
}

/**
 * Sus `apiId` van sin prefijo: es la fuente original y los ejercicios ya guardados
 * (y los entrenamientos que los referencian) usan esos ids tal cual.
 */
const freeExerciseDb: ExerciseSource = {
  id: 'free-exercise-db',
  fetchAll: async () => {
    const data = await fetchWithFallback();

    return data.map((item) => {
      // 1. Normalización de URL de la imagen principal (.jpg / .gif)
      let gifUrl = '';
      if (item.images && item.images.length > 0) {
        gifUrl = `${BASE_CDN_URL}${item.images[0]}`;
      } else if (item.gifUrl) {
        gifUrl = item.gifUrl.startsWith('http')
          ? item.gifUrl
          : `${BASE_CDN_URL}${item.gifUrl.replace(/^\/?(exercises\/)?/, '')}`;
      }

      // 2. Traducción de grupo muscular basado en el músculo primario
      const primaryMuscle = item.primaryMuscles?.[0]?.toLowerCase();
      const muscleGroup =
        (primaryMuscle && MUSCLE_GROUP_TRANSLATIONS[primaryMuscle]) ||
        MUSCLE_GROUP_TRANSLATIONS[item.bodyPart?.toLowerCase() || ''] ||
        MUSCLE_GROUP_TRANSLATIONS[item.target?.toLowerCase() || ''] ||
        'Otro';

      // 3. Traducción de equipamiento
      const equipmentKey = item.equipment?.toLowerCase() || '';
      const equipment = EQUIPMENT_TRANSLATIONS[equipmentKey] || 'Otro';

      return {
        apiId: item.id,
        name: capitalize(item.name),
        muscleGroup,
        equipment,
        gifUrl,
        instructions: item.instructions || [],
      };
    });
  },
};

/* ------------------------------------------------------------------------------------ */
/* wger (https://wger.de) — gratis, sin clave, con traducciones al español               */
/* ------------------------------------------------------------------------------------ */

const WGER_PREFIX = 'wger:';
// El máximo que acepta su paginación es 999; con eso el catálogo entra en pocas páginas.
const WGER_FIRST_PAGE = 'https://wger.de/api/v2/exerciseinfo/?limit=999&offset=0';
const WGER_MAX_PAGES = 20;
const WGER_PAGE_TIMEOUT_MS = 30_000;

const WGER_LANGUAGE_ES = 4;
const WGER_LANGUAGE_EN = 2;

// Ids de sus tablas fijas de músculos, categorías y equipamiento.
const WGER_MUSCLES: Record<number, string> = {
  1: 'Bíceps', // Biceps brachii
  2: 'Hombros', // Anterior deltoid
  3: 'Pecho', // Serratus anterior
  4: 'Pecho', // Pectoralis major
  5: 'Tríceps', // Triceps brachii
  6: 'Core', // Rectus abdominis
  7: 'Piernas', // Gastrocnemius
  8: 'Piernas', // Gluteus maximus
  9: 'Espalda', // Trapezius
  10: 'Piernas', // Quadriceps femoris
  11: 'Piernas', // Biceps femoris
  12: 'Espalda', // Latissimus dorsi
  13: 'Bíceps', // Brachialis
  14: 'Core', // Obliquus externus abdominis
  15: 'Piernas', // Soleus
  16: 'Espalda', // Erector spinae
};

const WGER_CARDIO_CATEGORY = 15;
const WGER_CATEGORIES: Record<number, string> = {
  9: 'Piernas', // Legs
  10: 'Core', // Abs
  11: 'Pecho', // Chest
  12: 'Espalda', // Back
  13: 'Hombros', // Shoulders
  14: 'Piernas', // Calves
  15: 'Cardio',
  // 8 (Arms) no alcanza para distinguir bíceps de tríceps: decide el músculo.
};

const WGER_EQUIPMENT: Record<number, string> = {
  1: 'Barra', // Barbell
  2: 'Barra', // SZ-Bar
  3: 'Mancuerna',
  4: 'Peso Corporal', // Gym mat
  5: 'Otro', // Swiss Ball
  6: 'Peso Corporal', // Pull-up bar
  7: 'Peso Corporal', // none (bodyweight exercise)
  10: 'Otro', // Kettlebell
  11: 'Otro', // Resistance band
  12: 'Polea', // Cable machine
};
// Bancos: acompañan a otro equipo, así que sólo cuentan si no hay nada más.
const WGER_SUPPORT_EQUIPMENT = new Set([8, 9]);
// Cuando hay varios, gana el más específico: el peso libre antes que el corporal.
const EQUIPMENT_PRIORITY = ['Barra', 'Mancuerna', 'Polea', 'Máquina', 'Otro', 'Peso Corporal'];

interface WgerNamed {
  id: number;
}

interface WgerTranslation {
  name: string;
  description?: string;
  language: number;
}

interface WgerExerciseInfo {
  id: number;
  category?: WgerNamed | null;
  muscles?: WgerNamed[];
  muscles_secondary?: WgerNamed[];
  equipment?: WgerNamed[];
  images?: { image: string; is_main?: boolean }[];
  translations?: WgerTranslation[];
}

interface WgerPage {
  next: string | null;
  results: WgerExerciseInfo[];
}

async function fetchWgerPage(url: string): Promise<WgerPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WGER_PAGE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`wger respondió ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Las descripciones de wger vienen en HTML: se pasan a una lista de pasos en texto plano. */
function htmlToSteps(html?: string): string[] {
  if (!html?.trim()) return [];

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blocks = Array.from(doc.querySelectorAll('li, p'))
    // Un <p> dentro de un <li> ya quedó incluido en el texto del <li>.
    .filter((element) => !element.parentElement?.closest('li'))
    .map((element) => element.textContent ?? '');
  const lines = blocks.length > 0 ? blocks : (doc.body.textContent ?? '').split('\n');

  return lines.map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function wgerMuscleGroup(item: WgerExerciseInfo): string {
  if (item.category?.id === WGER_CARDIO_CATEGORY) return 'Cardio';

  const muscles = [...(item.muscles ?? []), ...(item.muscles_secondary ?? [])];
  for (const muscle of muscles) {
    if (WGER_MUSCLES[muscle.id]) return WGER_MUSCLES[muscle.id];
  }
  return (item.category && WGER_CATEGORIES[item.category.id]) || 'Otro';
}

function wgerEquipment(item: WgerExerciseInfo): string {
  const main = (item.equipment ?? []).filter((equipment) => !WGER_SUPPORT_EQUIPMENT.has(equipment.id));
  const mapped = main.map((equipment) => WGER_EQUIPMENT[equipment.id] ?? 'Otro');
  if (mapped.length === 0) return 'Otro';

  return mapped.sort((a, b) => EQUIPMENT_PRIORITY.indexOf(a) - EQUIPMENT_PRIORITY.indexOf(b))[0];
}

function wgerToExercise(item: WgerExerciseInfo): Exercise | null {
  const translations = item.translations ?? [];
  const spanish = translations.find((translation) => translation.language === WGER_LANGUAGE_ES && translation.name?.trim());
  const english = translations.find((translation) => translation.language === WGER_LANGUAGE_EN && translation.name?.trim());
  const preferred = spanish ?? english;
  // Sin nombre en español ni en inglés no sirve para esta app.
  if (!preferred) return null;

  let instructions = htmlToSteps(preferred.description);
  if (instructions.length === 0 && preferred !== english) instructions = htmlToSteps(english?.description);

  const images = item.images ?? [];
  const image = images.find((candidate) => candidate.is_main) ?? images[0];

  return {
    apiId: `${WGER_PREFIX}${item.id}`,
    name: capitalize(preferred.name.trim()),
    muscleGroup: wgerMuscleGroup(item),
    equipment: wgerEquipment(item),
    gifUrl: image?.image ?? '',
    instructions,
  };
}

/**
 * Además del nombre elegido, devuelve el nombre en inglés para poder reconocer
 * ejercicios que ya vinieron de otra fuente con el nombre en inglés.
 */
function wgerAliases(item: WgerExerciseInfo): string[] {
  return (item.translations ?? [])
    .filter((translation) => translation.language === WGER_LANGUAGE_EN || translation.language === WGER_LANGUAGE_ES)
    .map((translation) => translation.name)
    .filter(Boolean);
}

const aliasesByApiId = new Map<string, string[]>();

const wger: ExerciseSource = {
  id: 'wger',
  fetchAll: async () => {
    const exercises: Exercise[] = [];
    let url: string | null = WGER_FIRST_PAGE;

    for (let page = 0; url && page < WGER_MAX_PAGES; page++) {
      const data = await fetchWgerPage(url);
      for (const item of data.results ?? []) {
        const exercise = wgerToExercise(item);
        if (!exercise) continue;
        aliasesByApiId.set(exercise.apiId as string, wgerAliases(item));
        exercises.push(exercise);
      }
      url = data.next ? data.next.replace(/^http:/, 'https:') : null;
    }

    return exercises;
  },
};

/* ------------------------------------------------------------------------------------ */
/* Unión de fuentes                                                                      */
/* ------------------------------------------------------------------------------------ */

/** Orden de prioridad: ante un duplicado se queda el de la fuente que aparece primero. */
const SOURCES: ExerciseSource[] = [freeExerciseDb, wger];

/** Fuente de la que salió un ejercicio del catálogo, o null si lo creó la persona usuaria. */
export function sourceOfExercise(exercise: Exercise): string | null {
  if (!exercise.apiId) return null;
  return exercise.apiId.startsWith(WGER_PREFIX) ? wger.id : freeExerciseDb.id;
}

/** Fuentes de las que el catálogo local todavía no tiene ningún ejercicio. */
export function missingSources(stored: Exercise[]): string[] {
  const present = new Set(stored.map(sourceOfExercise));
  return SOURCES.map((source) => source.id).filter((id) => !present.has(id));
}

/**
 * Clave para detectar el mismo ejercicio con nombres escritos distinto entre APIs:
 * sin acentos, mayúsculas ni signos, y con las palabras ordenadas, así
 * "Barbell Bench Press" y "Bench Press (Barbell)" dan lo mismo.
 */
export function exerciseNameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/**
 * De `incoming`, devuelve sólo los ejercicios que no están ya en `existing` (mismo
 * `apiId` o mismo nombre en cualquiera de sus idiomas), sin repetidos entre sí.
 */
export function pickNewExercises(existing: Exercise[], incoming: Exercise[]): Exercise[] {
  const knownApiIds = new Set(existing.map((exercise) => exercise.apiId).filter(Boolean));
  const knownNames = new Set(existing.map((exercise) => exerciseNameKey(exercise.name)));
  const fresh: Exercise[] = [];

  for (const exercise of incoming) {
    if (!exercise.apiId || knownApiIds.has(exercise.apiId)) continue;

    const names = [exercise.name, ...(aliasesByApiId.get(exercise.apiId) ?? [])].map(exerciseNameKey);
    if (names.some((name) => name && knownNames.has(name))) continue;

    fresh.push(exercise);
    knownApiIds.add(exercise.apiId);
    for (const name of names) if (name) knownNames.add(name);
  }

  return fresh;
}

/**
 * Consulta en paralelo todas las fuentes (o sólo las pedidas) y devuelve la unión sin
 * duplicados. Si una fuente falla se sigue con las demás; si fallan todas, [].
 */
export async function fetchExercises(sourceIds?: string[]): Promise<Exercise[]> {
  const sources = sourceIds ? SOURCES.filter((source) => sourceIds.includes(source.id)) : SOURCES;
  const results = await Promise.allSettled(sources.map((source) => source.fetchAll()));

  const all: Exercise[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      all.push(...result.value);
    } else {
      console.error(`[ExerciseAPI] La fuente ${sources[index].id} falló:`, result.reason);
    }
  });

  return pickNewExercises([], all);
}
