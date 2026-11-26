export interface ModelFile {
    name: string;
    url: string;
    size: number;
    sha256: string;
}

export interface SpeechModel {
    id: string;
    name: string;
    family: "parakeet" | "whisper" | "moonshine" | "sense-voice";
    languages: string;
    note: string;
    license: string;
    recommended?: boolean;
    files: ModelFile[];
}

export const MODELS: readonly SpeechModel[];
export function modelById(id: string): SpeechModel | undefined;
export function modelSize(model: SpeechModel): number;
