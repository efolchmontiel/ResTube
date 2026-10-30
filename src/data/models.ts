/** Identidad interna del catálogo conectado, compatible con el selector. */
export type ModelKey = string;
export interface RuntimeModel {
  provider: string;
  id: string;
  name: string;
  context?: string;
  maxOutput?: string;
  thinking?: boolean;
  images?: boolean;
}
export function modelKeyOf(model: RuntimeModel): ModelKey { return `${model.provider}:${model.id}`; }
export function findModel(models: RuntimeModel[], key: ModelKey | null | undefined): RuntimeModel | null {
  return key ? models.find((model) => modelKeyOf(model) === key) ?? null : null;
}
export function modelNameOf(models: RuntimeModel[], key: ModelKey | null | undefined): string {
  return findModel(models, key)?.name ?? '—';
}
export type Tone = 'accent' | 'blue' | 'green' | 'yellow';
export interface Takeaway { num: string; time: string; heading: string; text: string }
export interface DeepDive { heading: string; tone: Tone; paragraphs: string[]; code?: string }
export interface Actions { heading: string; tone: Tone; items?: string[]; paragraph?: string }
export interface Quote { text: string; author: string; tone: Tone }
