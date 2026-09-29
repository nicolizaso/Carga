import { create } from 'zustand';
import Dexie from 'dexie';
import { db, openDatabase } from '../lib/db';
import {
  CATALOG_MAPPING_VERSION,
  fetchExercises,
  missingSources,
  pickNewExercises,
  sourceOfExercise,
} from '../lib/exerciseApi';
import { calculateWeekTarget } from '../lib/progression';
import type {
  Exercise,
  WorkoutSet,
  Routine,
  ActiveWorkoutDraft,
  ActiveExerciseData,
  ActiveSetInput,
  WorkoutSummary,
} from '../types';

/** Una sesión ya entrenada de un día del plan: qué semana cubrió y cuándo. */
export interface PlanCompletion {
  workoutId: number;
  planDayId: number;
  weekIndex: number;
  date: Date;
}

const CATALOG_MAPPING_VERSION_KEY = 'carga:catalog-mapping-version';

function catalogMappingIsOutdated(): boolean {
  try {
    return Number(window.localStorage.getItem(CATALOG_MAPPING_VERSION_KEY)) < CATALOG_MAPPING_VERSION;
  } catch {
    return false;
  }
}

function markCatalogMappingUpToDate() {
  try {
    window.localStorage.setItem(CATALOG_MAPPING_VERSION_KEY, String(CATALOG_MAPPING_VERSION));
  } catch {
    // Sin almacenamiento se vuelve a recalcular la próxima vez; no rompe nada.
  }
}

/**
 * Vuelca el catálogo remoto en la base local: suma los ejercicios nuevos y corrige el grupo
 * muscular y el equipamiento de los que ya estaban (no son editables, sólo las notas lo son).
 */
async function syncCatalog(remote: Exercise[]): Promise<void> {
  const stored = await db.exercises.toArray();
  const byApiId = new Map(remote.map((exercise) => [exercise.apiId, exercise]));

  await db.transaction('rw', db.exercises, async () => {
    for (const exercise of stored) {
      const fresh = exercise.apiId ? byApiId.get(exercise.apiId) : undefined;
      if (!fresh || typeof exercise.id !== 'number') continue;
      if (fresh.muscleGroup === exercise.muscleGroup && fresh.equipment === exercise.equipment) continue;
      await db.exercises.update(exercise.id, { muscleGroup: fresh.muscleGroup, equipment: fresh.equipment });
    }

    const incoming = pickNewExercises(stored, remote);
    if (incoming.length > 0) await db.exercises.bulkAdd(incoming);
  });
}

const REST_BETWEEN_SETS_KEY = 'carga:rest-between-sets-seconds';
const REST_BETWEEN_EXERCISES_KEY = 'carga:rest-between-exercises-seconds';
const DEFAULT_REST_BETWEEN_SETS_SECONDS = 30;
const DEFAULT_REST_BETWEEN_EXERCISES_SECONDS = 90;

function readRestPreference(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback;
  const stored = Number(window.localStorage.getItem(key));
  return Number.isFinite(stored) && stored > 0 ? stored : fallback;
}

/** Copia profunda de la lista de ejercicios activos: evita mutar el estado. */
function cloneExercises(exercises: ActiveExerciseData[]): ActiveExerciseData[] {
  return exercises.map((exercise) => ({
    ...exercise,
    sets: exercise.sets.map((set) => ({ ...set })),
  }));
}

export interface PreviousSet {
  weight: number;
  reps: number;
}

interface GymState {
  isLoading: boolean;
  loadError: string | null;
  exercises: Exercise[];
  routines: Routine[];

  isWorkoutActive: boolean;
  activeWorkoutId: number | null;
  activeWorkoutName: string;
  activeWorkoutStartTime: Date | null;
  activeExercises: ActiveExerciseData[];
  currentExerciseIndex: number;

  /** Día del plan que se está entrenando y su semana de progresión; `null` en una rutina
   *  suelta o un entrenamiento libre. Es lo que hace que la sesión impacte en el plan. */
  activePlanId: number | null;
  activePlanDayId: number | null;
  activeWeekIndex: number | null;

  restTimerTarget: number | null;
  restTimerDuration: number;
  /** Descanso entre series de un mismo ejercicio. */
  restBetweenSetsSeconds: number;
  /** Descanso al completar la última serie de un ejercicio y pasar al siguiente. */
  restBetweenExercisesSeconds: number;

  /** Resumen de la última sesión cerrada, para mostrarlo al salir del modo entrenamiento. */
  lastSummary: WorkoutSummary | null;
  clearLastSummary: () => void;

  init: () => Promise<void>;
  refreshExercisesFromApi: () => Promise<void>;

  startWorkout: (name?: string) => Promise<void>;
  loadRoutineIntoWorkout: (routineId: number) => Promise<void>;
  loadPlanDayIntoWorkout: (planDayId: number, weekIndex: number) => Promise<void>;
  finishWorkout: () => Promise<WorkoutSummary | null>;
  cancelWorkout: () => Promise<void>;
  saveActiveDraft: () => void;

  createRoutine: (name: string, exercises: RoutineExercisePayload[]) => Promise<void>;
  updateRoutine: (id: number, name: string, exercises: RoutineExercisePayload[]) => Promise<void>;
  deleteRoutine: (id: number) => Promise<void>;
  getRoutines: () => Promise<void>;

  /** Relee el catálogo de ejercicios sin tocar el resto del estado (ej. tras importar datos). */
  refreshExercises: () => Promise<void>;

  setCurrentExerciseIndex: (index: number) => void;
  addActiveExercise: (exercise: Exercise) => Promise<void>;
  removeActiveExercise: (exerciseIndex: number) => Promise<void>;
  moveActiveExercise: (exerciseIndex: number, direction: -1 | 1) => void;
  swapActiveExercise: (exerciseIndex: number, newExercise: Exercise) => Promise<void>;

  addExercise: (data: {
    name: string;
    muscleGroup: string;
    equipment?: string;
    fitNotes?: string;
    gifUrl?: string;
    instructions?: string[];
  }) => Promise<Exercise | null>;
  updateExerciseFitNotes: (exerciseId: number, fitNotes: string) => Promise<void>;

  updateSet: (exerciseIndex: number, setIndex: number, field: 'weight' | 'reps', value: string) => void;
  toggleSetComplete: (exerciseIndex: number, setIndex: number) => Promise<'completed' | 'undone' | 'invalid'>;
  addSet: (exerciseIndex: number) => void;
  removeSet: (exerciseIndex: number, setIndex: number) => Promise<void>;

  getHistory: (exerciseId: number) => Promise<WorkoutSet[]>;
  getPreviousPerformance: (exerciseId: number, excludeWorkoutId?: number | null) => Promise<PreviousSet[]>;
  getWorkoutsForMonth: (year: number, month: number) => Promise<{ day: number; workoutId: number }[]>;
  /** Sesiones ya entrenadas de un plan (o de todos, si no se pasa `planId`). */
  getPlanCompletions: (planId?: number) => Promise<PlanCompletion[]>;

  startRestTimer: (durationSeconds?: number) => void;
  adjustRestTimer: (deltaSeconds: number) => void;
  stopRestTimer: () => void;
  setRestBetweenSetsSeconds: (seconds: number) => void;
  setRestBetweenExercisesSeconds: (seconds: number) => void;
}

export interface RoutineExercisePayload {
  exerciseId: number;
  targetSets: number;
  targetReps: string;
  targetWeight?: string;
}

/** Guardado del borrador con "debounce": escribir en cada tecla es innecesario. */
let draftTimeout: ReturnType<typeof setTimeout> | null = null;

export const calculate1RM = (weight: number, reps: number): number => {
  if (!Number.isFinite(weight) || !Number.isFinite(reps) || reps <= 0) return 0;
  if (reps === 1) return Math.round(weight);
  return Math.round(weight * (1 + reps / 30));
};

export const useGymStore = create<GymState>((set, get) => ({
  isLoading: false,
  loadError: null,
  exercises: [],
  routines: [],

  isWorkoutActive: false,
  activeWorkoutId: null,
  activeWorkoutName: 'Entrenamiento libre',
  activeWorkoutStartTime: null,
  activeExercises: [],
  currentExerciseIndex: 0,

  activePlanId: null,
  activePlanDayId: null,
  activeWeekIndex: null,

  restTimerTarget: null,
  restTimerDuration: readRestPreference(REST_BETWEEN_SETS_KEY, DEFAULT_REST_BETWEEN_SETS_SECONDS),
  restBetweenSetsSeconds: readRestPreference(REST_BETWEEN_SETS_KEY, DEFAULT_REST_BETWEEN_SETS_SECONDS),
  restBetweenExercisesSeconds: readRestPreference(REST_BETWEEN_EXERCISES_KEY, DEFAULT_REST_BETWEEN_EXERCISES_SECONDS),
  lastSummary: null,

  clearLastSummary: () => set({ lastSummary: null }),

  saveActiveDraft: () => {
    if (draftTimeout) clearTimeout(draftTimeout);

    draftTimeout = setTimeout(async () => {
      const state = get();

      if (!state.isWorkoutActive || !state.activeWorkoutId || !state.activeWorkoutStartTime) {
        await db.activeWorkoutDraft.clear().catch(() => {});
        return;
      }

      const draft: ActiveWorkoutDraft = {
        id: 1,
        workoutId: state.activeWorkoutId,
        name: state.activeWorkoutName,
        startTime: state.activeWorkoutStartTime,
        planId: state.activePlanId ?? undefined,
        planDayId: state.activePlanDayId ?? undefined,
        weekIndex: state.activeWeekIndex ?? undefined,
        activeExercises: state.activeExercises,
        currentExerciseIndex: state.currentExerciseIndex,
        restTimerTarget: state.restTimerTarget,
        restTimerDuration: state.restTimerDuration,
      };

      try {
        await db.activeWorkoutDraft.put(draft);
      } catch (err) {
        console.error('No se pudo guardar el borrador del entrenamiento', err);
      }
    }, 250);
  },

  /**
   * Arranque de la app:
   * 1. Restaura el entrenamiento en curso si la sesión se cortó.
   * 2. Descarga el catálogo de ejercicios la primera vez y lo cachea local.
   * Los ejercicios propios NUNCA se borran.
   */
  init: async () => {
    if (get().isLoading) return;
    set({ isLoading: true, loadError: null });

    try {
      await openDatabase();

      const draft = (await db.activeWorkoutDraft.toArray())[0];
      if (draft) {
        set({
          isWorkoutActive: true,
          activeWorkoutId: draft.workoutId,
          activeWorkoutName: draft.name || 'Entrenamiento libre',
          activeWorkoutStartTime: new Date(draft.startTime),
          activePlanId: draft.planId ?? null,
          activePlanDayId: draft.planDayId ?? null,
          activeWeekIndex: draft.weekIndex ?? null,
          activeExercises: draft.activeExercises ?? [],
          currentExerciseIndex: draft.currentExerciseIndex ?? 0,
          restTimerTarget: draft.restTimerTarget,
          restTimerDuration:
            draft.restTimerDuration || readRestPreference(REST_BETWEEN_SETS_KEY, DEFAULT_REST_BETWEEN_SETS_SECONDS),
        });
      }

      let stored = await db.exercises.toArray();

      // Limpieza puntual de las semillas hardcodeadas antiguas: no venían de la
      // API y tampoco las creó la persona usuaria.
      const orphanIds = stored
        .filter((exercise) => !exercise.apiId && !exercise.isCustom)
        .map((exercise) => exercise.id)
        .filter((id): id is number => typeof id === 'number');

      if (orphanIds.length > 0) {
        await db.exercises.bulkDelete(orphanIds);
        stored = stored.filter((exercise) => !orphanIds.includes(exercise.id as number));
      }

      const catalogWasEmpty = stored.length === 0;
      if (catalogWasEmpty) {
        const remote = await fetchExercises();

        if (remote.length > 0) {
          await db.exercises.bulkAdd(remote);
          stored = await db.exercises.toArray();
          markCatalogMappingUpToDate();
        }
      }

      const routines = await db.routines.toArray();

      set({
        exercises: stored,
        routines,
        isLoading: false,
        loadError:
          stored.length === 0
            ? 'No pudimos descargar el catálogo de ejercicios. Revisá tu conexión o creá los tuyos.'
            : null,
      });

      // Quien ya tenía el catálogo de antes no tiene las fuentes que se sumaron después, y
      // si cambiaron las traducciones sus categorías quedaron viejas: se pone al día en
      // segundo plano, sin spinner ni error si las APIs no responden.
      const missing = catalogWasEmpty ? [] : missingSources(stored);
      const remap = !catalogWasEmpty && stored.some((exercise) => exercise.apiId) && catalogMappingIsOutdated();
      if (missing.length > 0 || remap) {
        void (async () => {
          try {
            const remote = await fetchExercises(remap ? undefined : missing);
            if (remote.length === 0) return;
            await syncCatalog(remote);
            set({ exercises: await db.exercises.toArray() });

            // Recalculado sólo si respondieron todas las fuentes que ya estaban guardadas.
            const answered = new Set(remote.map(sourceOfExercise));
            const expected = new Set(stored.map(sourceOfExercise).filter(Boolean));
            if ([...expected].every((source) => answered.has(source))) markCatalogMappingUpToDate();
          } catch (error) {
            console.warn('No se pudo poner al día el catálogo', error);
          }
        })();
      }
    } catch (error) {
      console.error('Error al inicializar Carga:', error);
      set({ isLoading: false, loadError: 'No se pudo iniciar la base de datos local.' });
    }
  },

  refreshExercisesFromApi: async () => {
    set({ isLoading: true, loadError: null });
    try {
      const remote = await fetchExercises();
      if (remote.length === 0) {
        set({ isLoading: false, loadError: 'El catálogo remoto no respondió. Intentá de nuevo más tarde.' });
        return;
      }

      await syncCatalog(remote);

      set({ exercises: await db.exercises.toArray(), isLoading: false });
    } catch (error) {
      console.error('No se pudo refrescar el catálogo', error);
      set({ isLoading: false, loadError: 'No se pudo refrescar el catálogo de ejercicios.' });
    }
  },

  startWorkout: async (name = 'Entrenamiento libre') => {
    const startTime = new Date();
    try {
      const id = await db.workouts.add({ date: startTime, name, durationSeconds: 0 });

      set({
        isWorkoutActive: true,
        activeWorkoutId: id as number,
        activeWorkoutName: name,
        activeWorkoutStartTime: startTime,
        activeExercises: [],
        currentExerciseIndex: 0,
        activePlanId: null,
        activePlanDayId: null,
        activeWeekIndex: null,
        restTimerTarget: null,
      });
      get().saveActiveDraft();
    } catch (err) {
      console.error('No se pudo iniciar el entrenamiento', err);
    }
  },

  loadRoutineIntoWorkout: async (routineId) => {
    try {
      const routine = await db.routines.get(routineId);
      if (!routine) return;

      const routineExercises = await db.routineExercises.where('routineId').equals(routineId).sortBy('order');
      const catalog = await db.exercises.toArray();

      const startTime = new Date();
      const workoutId = (await db.workouts.add({
        date: startTime,
        name: routine.name,
        durationSeconds: 0,
      })) as number;

      const activeExercises: ActiveExerciseData[] = [];

      for (const routineExercise of routineExercises) {
        const definition = catalog.find((item) => item.id === routineExercise.exerciseId);
        if (!definition) continue;

        const sets: ActiveSetInput[] = Array.from({ length: Math.max(1, routineExercise.targetSets) }).map(() => ({
          weight: routineExercise.targetWeight || '',
          reps: routineExercise.targetReps || '',
          completed: false,
        }));

        activeExercises.push({
          exerciseId: routineExercise.exerciseId,
          name: definition.name,
          muscleGroup: definition.muscleGroup,
          sets,
          previous: await get().getPreviousPerformance(routineExercise.exerciseId, workoutId),
        });
      }

      set({
        isWorkoutActive: true,
        activeWorkoutId: workoutId,
        activeWorkoutName: routine.name,
        activeWorkoutStartTime: startTime,
        activeExercises,
        currentExerciseIndex: 0,
        activePlanId: null,
        activePlanDayId: null,
        activeWeekIndex: null,
        restTimerTarget: null,
      });
      get().saveActiveDraft();
    } catch (err) {
      console.error('No se pudo cargar la rutina', err);
    }
  },

  /**
   * Arranca un entrenamiento con los sets/reps/peso que le tocan a esa semana de un día
   * del plan. Los ejercicios y su orden son siempre los de la rutina de ese día; para cada
   * uno se usa la progresión configurada si existe, y si no (ejercicio agregado a la
   * rutina después de armar el plan) se cae al peso/reps/series propios de la rutina, sin
   * aumento automático.
   */
  loadPlanDayIntoWorkout: async (planDayId, weekIndex) => {
    try {
      const planDay = await db.planDays.get(planDayId);
      if (!planDay) return;
      const plan = await db.trainingPlans.get(planDay.planId);
      if (!plan) return;

      const routineExercises = await db.routineExercises
        .where('routineId')
        .equals(planDay.routineId)
        .sortBy('order');
      const planExercises = await db.planExercises.where('planDayId').equals(planDayId).toArray();
      const catalog = await db.exercises.toArray();

      const startTime = new Date();
      const workoutName = `${plan.name} · ${planDay.label} · Semana ${weekIndex + 1}`;
      // El vínculo con el plan se guarda desde el arranque: así la sesión queda imputada al
      // día y a la semana que se está entrenando aunque el navegador se cierre a mitad.
      const workoutId = (await db.workouts.add({
        date: startTime,
        name: workoutName,
        durationSeconds: 0,
        planId: planDay.planId,
        planDayId,
        weekIndex,
      })) as number;

      const activeExercises: ActiveExerciseData[] = [];

      for (const routineExercise of routineExercises) {
        const definition = catalog.find((item) => item.id === routineExercise.exerciseId);
        if (!definition) continue;

        const planExercise = planExercises.find((item) => item.exerciseId === routineExercise.exerciseId);

        let sets: ActiveSetInput[];
        if (planExercise) {
          const target = calculateWeekTarget(
            planExercise.initialWeight,
            planExercise.equipmentType,
            weekIndex,
            planExercise.incrementOverride
          );

          sets = Array.from({ length: target.sets }).map(() => ({
            weight: String(target.weight),
            reps: String(target.reps),
            completed: false,
          }));
        } else {
          sets = Array.from({ length: Math.max(1, routineExercise.targetSets) }).map(() => ({
            weight: routineExercise.targetWeight || '',
            reps: routineExercise.targetReps || '',
            completed: false,
          }));
        }

        activeExercises.push({
          exerciseId: routineExercise.exerciseId,
          name: definition.name,
          muscleGroup: definition.muscleGroup,
          sets,
          previous: await get().getPreviousPerformance(routineExercise.exerciseId, workoutId),
        });
      }

      set({
        isWorkoutActive: true,
        activeWorkoutId: workoutId,
        activeWorkoutName: workoutName,
        activeWorkoutStartTime: startTime,
        activeExercises,
        currentExerciseIndex: 0,
        activePlanId: planDay.planId,
        activePlanDayId: planDayId,
        activeWeekIndex: weekIndex,
        restTimerTarget: null,
      });
      get().saveActiveDraft();
    } catch (err) {
      console.error('No se pudo cargar la semana del plan', err);
    }
  },

  finishWorkout: async () => {
    const { activeWorkoutId, activeWorkoutStartTime, activeWorkoutName, activeExercises } = get();
    if (!activeWorkoutId || !activeWorkoutStartTime) return null;

    const durationSeconds = Math.max(
      0,
      Math.round((Date.now() - new Date(activeWorkoutStartTime).getTime()) / 1000)
    );

    const completedSets = activeExercises.flatMap((exercise) =>
      exercise.sets.filter((item) => item.completed)
    );

    const summary: WorkoutSummary = {
      name: activeWorkoutName,
      durationSeconds,
      totalSets: completedSets.length,
      totalReps: completedSets.reduce((total, item) => total + (parseFloat(item.reps) || 0), 0),
      totalVolume: completedSets.reduce(
        (total, item) => total + (parseFloat(item.weight) || 0) * (parseFloat(item.reps) || 0),
        0
      ),
      exerciseCount: activeExercises.filter((exercise) => exercise.sets.some((item) => item.completed)).length,
    };

    try {
      if (summary.totalSets === 0) {
        // Sesión vacía: no ensuciamos el historial ni el calendario.
        await db.workouts.delete(activeWorkoutId);
      } else {
        await db.workouts.update(activeWorkoutId, { durationSeconds });
      }
    } catch (err) {
      console.error('No se pudo cerrar el entrenamiento', err);
    }

    set({
      isWorkoutActive: false,
      activeWorkoutId: null,
      activeWorkoutStartTime: null,
      activeWorkoutName: 'Entrenamiento libre',
      activeExercises: [],
      currentExerciseIndex: 0,
      activePlanId: null,
      activePlanDayId: null,
      activeWeekIndex: null,
      restTimerTarget: null,
      lastSummary: summary,
    });
    await db.activeWorkoutDraft.clear().catch(() => {});

    return summary;
  },

  cancelWorkout: async () => {
    const { activeWorkoutId } = get();

    if (activeWorkoutId) {
      try {
        await db.transaction('rw', db.workouts, db.sets, async () => {
          await db.workouts.delete(activeWorkoutId);
          await db.sets.where('workoutId').equals(activeWorkoutId).delete();
        });
      } catch (err) {
        console.error('No se pudo descartar el entrenamiento', err);
      }
    }

    set({
      isWorkoutActive: false,
      activeWorkoutId: null,
      activeWorkoutStartTime: null,
      activeWorkoutName: 'Entrenamiento libre',
      activeExercises: [],
      currentExerciseIndex: 0,
      activePlanId: null,
      activePlanDayId: null,
      activeWeekIndex: null,
      restTimerTarget: null,
    });
    await db.activeWorkoutDraft.clear().catch(() => {});
  },

  createRoutine: async (name, exercises) => {
    try {
      await db.transaction('rw', db.routines, db.routineExercises, async () => {
        const routineId = (await db.routines.add({ name, created_at: new Date() })) as number;

        await db.routineExercises.bulkAdd(
          exercises.map((exercise, index) => ({
            routineId,
            exerciseId: Number(exercise.exerciseId),
            order: index,
            targetSets: exercise.targetSets,
            targetReps: exercise.targetReps,
            targetWeight: exercise.targetWeight,
          }))
        );
      });
      await get().getRoutines();
    } catch (err) {
      console.error('No se pudo crear la rutina', err);
    }
  },

  updateRoutine: async (id, name, exercises) => {
    try {
      await db.transaction('rw', db.routines, db.routineExercises, async () => {
        await db.routines.update(id, { name });
        await db.routineExercises.where('routineId').equals(id).delete();

        await db.routineExercises.bulkAdd(
          exercises.map((exercise, index) => ({
            routineId: id,
            exerciseId: Number(exercise.exerciseId),
            order: index,
            targetSets: exercise.targetSets,
            targetReps: exercise.targetReps,
            targetWeight: exercise.targetWeight,
          }))
        );
      });
      await get().getRoutines();
    } catch (err) {
      console.error('No se pudo actualizar la rutina', err);
    }
  },

  deleteRoutine: async (id) => {
    try {
      await db.transaction('rw', db.routines, db.routineExercises, async () => {
        await db.routines.delete(id);
        await db.routineExercises.where('routineId').equals(id).delete();
      });
      await get().getRoutines();
    } catch (err) {
      console.error('No se pudo eliminar la rutina', err);
    }
  },

  getRoutines: async () => {
    try {
      set({ routines: await db.routines.toArray() });
    } catch (err) {
      console.error('No se pudieron leer las rutinas', err);
    }
  },

  refreshExercises: async () => {
    try {
      set({ exercises: await db.exercises.toArray() });
    } catch (err) {
      console.error('No se pudo releer el catálogo de ejercicios', err);
    }
  },

  setCurrentExerciseIndex: (index) => {
    const { activeExercises } = get();
    const clamped = Math.min(Math.max(0, index), Math.max(0, activeExercises.length - 1));
    set({ currentExerciseIndex: clamped });
    get().saveActiveDraft();
  },

  addActiveExercise: async (exercise) => {
    if (typeof exercise.id !== 'number') return;

    const { activeExercises, activeWorkoutId } = get();
    const previous = await get().getPreviousPerformance(exercise.id, activeWorkoutId);

    set({
      activeExercises: [
        ...cloneExercises(activeExercises),
        {
          exerciseId: exercise.id,
          name: exercise.name,
          muscleGroup: exercise.muscleGroup,
          previous,
          sets: [
            {
              weight: previous[0] ? String(previous[0].weight) : '',
              reps: previous[0] ? String(previous[0].reps) : '',
              completed: false,
            },
          ],
        },
      ],
      // Si era la primera, el foco se posa ahí; si no, no interrumpimos la serie
      // que la persona está haciendo ahora.
      currentExerciseIndex: activeExercises.length === 0 ? 0 : get().currentExerciseIndex,
    });
    get().saveActiveDraft();
  },

  removeActiveExercise: async (exerciseIndex) => {
    const { activeExercises, currentExerciseIndex } = get();
    const target = activeExercises[exerciseIndex];
    if (!target) return;

    // Las series ya registradas de ese ejercicio se dan de baja también.
    const loggedIds = target.sets.map((item) => item.logId).filter((id): id is number => typeof id === 'number');
    if (loggedIds.length > 0) await db.sets.bulkDelete(loggedIds).catch(() => {});

    const next = cloneExercises(activeExercises).filter((_, index) => index !== exerciseIndex);

    set({
      activeExercises: next,
      currentExerciseIndex: Math.min(currentExerciseIndex, Math.max(0, next.length - 1)),
    });
    get().saveActiveDraft();
  },

  moveActiveExercise: (exerciseIndex, direction) => {
    const next = cloneExercises(get().activeExercises);
    const target = exerciseIndex + direction;
    if (!next[exerciseIndex] || !next[target]) return;

    [next[exerciseIndex], next[target]] = [next[target], next[exerciseIndex]];
    set({ activeExercises: next, currentExerciseIndex: target });
    get().saveActiveDraft();
  },

  swapActiveExercise: async (exerciseIndex, newExercise) => {
    if (typeof newExercise.id !== 'number') return;

    const { activeExercises, activeWorkoutId } = get();
    const current = activeExercises[exerciseIndex];
    if (!current) return;

    // Las series ya registradas pertenecían al ejercicio anterior.
    const loggedIds = current.sets.map((item) => item.logId).filter((id): id is number => typeof id === 'number');
    if (loggedIds.length > 0) await db.sets.bulkDelete(loggedIds).catch(() => {});

    const previous = await get().getPreviousPerformance(newExercise.id, activeWorkoutId);
    const next = cloneExercises(activeExercises);

    next[exerciseIndex] = {
      exerciseId: newExercise.id,
      name: newExercise.name,
      muscleGroup: newExercise.muscleGroup,
      previous,
      sets: current.sets.map((_, index) => ({
        weight: previous[index] ? String(previous[index].weight) : '',
        reps: previous[index] ? String(previous[index].reps) : '',
        completed: false,
      })),
    };

    set({ activeExercises: next });
    get().saveActiveDraft();
  },

  addExercise: async ({ name, muscleGroup, equipment, fitNotes, gifUrl, instructions }) => {
    const trimmed = name.trim();
    if (!trimmed) return null;

    try {
      const existing = get().exercises.find(
        (exercise) => exercise.name.toLowerCase() === trimmed.toLowerCase()
      );
      if (existing) return existing;

      const id = (await db.exercises.add({
        name: trimmed,
        muscleGroup,
        equipment,
        fitNotes,
        gifUrl,
        instructions,
        isCustom: true,
      })) as number;

      const exercises = await db.exercises.toArray();
      set({ exercises });

      return exercises.find((exercise) => exercise.id === id) ?? null;
    } catch (err) {
      console.error('No se pudo crear el ejercicio', err);
      return null;
    }
  },

  updateExerciseFitNotes: async (exerciseId, fitNotes) => {
    try {
      await db.exercises.update(exerciseId, { fitNotes });
      set({
        exercises: get().exercises.map((exercise) =>
          exercise.id === exerciseId ? { ...exercise, fitNotes } : exercise
        ),
      });
    } catch (err) {
      console.error('No se pudieron guardar las notas', err);
    }
  },

  updateSet: (exerciseIndex, setIndex, field, value) => {
    const next = cloneExercises(get().activeExercises);
    const target = next[exerciseIndex]?.sets[setIndex];
    if (!target) return;

    target[field] = value;
    set({ activeExercises: next });

    // Si la serie ya estaba registrada, sincronizamos la fila persistida.
    if (target.completed && typeof target.logId === 'number') {
      const numeric = parseFloat(value);
      if (Number.isFinite(numeric)) {
        db.sets.update(target.logId, { [field]: numeric }).catch(() => {});
      }
    }

    get().saveActiveDraft();
  },

  toggleSetComplete: async (exerciseIndex, setIndex) => {
    const { activeExercises, activeWorkoutId, startRestTimer } = get();
    const exercise = activeExercises[exerciseIndex];
    const current = exercise?.sets[setIndex];
    if (!exercise || !current || !activeWorkoutId) return 'invalid';

    // Deshacer: se borra el registro persistido para no duplicar series.
    if (current.completed) {
      if (typeof current.logId === 'number') {
        await db.sets.delete(current.logId).catch(() => {});
      }

      const next = cloneExercises(activeExercises);
      next[exerciseIndex].sets[setIndex] = { ...current, completed: false, logId: undefined };
      set({ activeExercises: next });
      get().saveActiveDraft();
      return 'undone';
    }

    const weight = parseFloat(current.weight);
    const reps = parseFloat(current.reps);

    // Sin carga y repeticiones válidas no hay nada que registrar: mejor avisar
    // que marcar una serie que después no aparece en el historial.
    if (!Number.isFinite(weight) || !Number.isFinite(reps) || reps <= 0 || weight < 0) {
      return 'invalid';
    }

    try {
      const logId = (await db.sets.add({
        workoutId: activeWorkoutId,
        exerciseId: exercise.exerciseId,
        weight,
        reps,
        date: new Date(),
      })) as number;

      const next = cloneExercises(get().activeExercises);
      if (next[exerciseIndex]?.sets[setIndex]) {
        next[exerciseIndex].sets[setIndex] = { ...next[exerciseIndex].sets[setIndex], completed: true, logId };
        set({ activeExercises: next });
      }

      get().saveActiveDraft();

      // Si era la última serie pendiente del ejercicio, lo que sigue es cambiar de
      // ejercicio: el descanso es más largo que entre series del mismo ejercicio.
      const wasLastSet = next[exerciseIndex]?.sets.every((item) => item.completed) ?? false;
      startRestTimer(wasLastSet ? get().restBetweenExercisesSeconds : get().restBetweenSetsSeconds);
      return 'completed';
    } catch (err) {
      console.error('No se pudo registrar la serie', err);
      return 'invalid';
    }
  },

  addSet: (exerciseIndex) => {
    const next = cloneExercises(get().activeExercises);
    const exercise = next[exerciseIndex];
    if (!exercise) return;

    // La serie nueva arranca con los valores de la anterior (o los de la sesión
    // pasada si es la primera): casi siempre es lo que se quiere repetir.
    const last = exercise.sets[exercise.sets.length - 1];
    const reference = exercise.previous?.[exercise.sets.length];

    exercise.sets.push({
      weight: last?.weight || (reference ? String(reference.weight) : ''),
      reps: last?.reps || (reference ? String(reference.reps) : ''),
      completed: false,
    });

    set({ activeExercises: next });
    get().saveActiveDraft();
  },

  removeSet: async (exerciseIndex, setIndex) => {
    const { activeExercises } = get();
    const target = activeExercises[exerciseIndex]?.sets[setIndex];
    if (!target) return;

    if (typeof target.logId === 'number') await db.sets.delete(target.logId).catch(() => {});

    const next = cloneExercises(activeExercises);
    next[exerciseIndex].sets.splice(setIndex, 1);

    set({ activeExercises: next });
    get().saveActiveDraft();
  },

  getHistory: async (exerciseId) =>
    db.sets
      .where('[exerciseId+date]')
      .between([exerciseId, Dexie.minKey], [exerciseId, Dexie.maxKey])
      .reverse()
      .limit(30)
      .toArray(),

  /** Series del último entrenamiento en el que se hizo ese ejercicio. */
  getPreviousPerformance: async (exerciseId, excludeWorkoutId = null) => {
    try {
      const history = await db.sets
        .where('[exerciseId+date]')
        .between([exerciseId, Dexie.minKey], [exerciseId, Dexie.maxKey])
        .reverse()
        .limit(60)
        .toArray();

      const lastWorkoutId = history.find((item) => item.workoutId !== excludeWorkoutId)?.workoutId;
      if (lastWorkoutId === undefined) return [];

      return history
        .filter((item) => item.workoutId === lastWorkoutId)
        .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
        .map((item) => ({ weight: item.weight, reps: item.reps }));
    } catch (err) {
      console.error('No se pudo leer el histórico del ejercicio', err);
      return [];
    }
  },

  getWorkoutsForMonth: async (year, month) => {
    const start = new Date(year, month, 1);
    const end = new Date(year, month + 1, 0, 23, 59, 59, 999);

    const workouts = await db.workouts.where('date').between(start, end, true, true).toArray();

    return workouts
      .filter((workout) => typeof workout.id === 'number')
      .map((workout) => ({ day: new Date(workout.date).getDate(), workoutId: workout.id as number }));
  },

  /**
   * Sesiones que ya se entrenaron de un plan. Una sesión vacía o descartada se borra al
   * cerrarla, así que toda fila con `planDayId` cuenta como entrenada; la única excepción es
   * la que está abierta en este momento, que todavía no terminó.
   */
  getPlanCompletions: async (planId) => {
    try {
      const rows =
        typeof planId === 'number'
          ? await db.workouts.where('planId').equals(planId).toArray()
          : await db.workouts.filter((workout) => typeof workout.planDayId === 'number').toArray();

      const activeWorkoutId = get().activeWorkoutId;

      return rows
        .filter(
          (workout) =>
            typeof workout.id === 'number' &&
            typeof workout.planDayId === 'number' &&
            typeof workout.weekIndex === 'number' &&
            workout.id !== activeWorkoutId
        )
        .map((workout) => ({
          workoutId: workout.id as number,
          planDayId: workout.planDayId as number,
          weekIndex: workout.weekIndex as number,
          date: new Date(workout.date),
        }));
    } catch (err) {
      console.error('No se pudieron leer las sesiones entrenadas del plan', err);
      return [];
    }
  },

  startRestTimer: (durationSeconds) => {
    const duration = durationSeconds ?? get().restBetweenSetsSeconds;
    set({ restTimerDuration: duration, restTimerTarget: Date.now() + duration * 1000 });
    get().saveActiveDraft();
  },

  adjustRestTimer: (deltaSeconds) => {
    const { restTimerTarget, restTimerDuration } = get();
    if (!restTimerTarget) return;

    const target = Math.max(Date.now() + 1000, restTimerTarget + deltaSeconds * 1000);
    set({
      restTimerTarget: target,
      restTimerDuration: Math.max(restTimerDuration + deltaSeconds, Math.ceil((target - Date.now()) / 1000)),
    });
    get().saveActiveDraft();
  },

  stopRestTimer: () => {
    if (get().restTimerTarget === null) return;
    set({ restTimerTarget: null });
    get().saveActiveDraft();
  },

  setRestBetweenSetsSeconds: (seconds) => {
    const safe = Math.min(600, Math.max(15, Math.round(seconds)));
    window.localStorage.setItem(REST_BETWEEN_SETS_KEY, String(safe));
    set({ restBetweenSetsSeconds: safe });
  },

  setRestBetweenExercisesSeconds: (seconds) => {
    const safe = Math.min(600, Math.max(15, Math.round(seconds)));
    window.localStorage.setItem(REST_BETWEEN_EXERCISES_KEY, String(safe));
    set({ restBetweenExercisesSeconds: safe });
  },
}));
