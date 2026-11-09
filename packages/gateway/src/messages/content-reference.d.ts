export function validateTextReferenceSource(value:unknown,conversation:string):void;
export function validateRegionCaptureSource(value:unknown,conversation:string):unknown;
export function validateContentReference(value:unknown):Record<string,unknown>;
export function readLiteralMessageReferences(blocks:readonly unknown[]):Array<Record<string,unknown>>;
