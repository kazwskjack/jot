export interface SkillManifest{name:string;description:string;whenToUse?:string;invocation:{modelInvocable:boolean;userInvocable:boolean};source:string;provider:string}
export interface SkillCatalogItem extends SkillManifest{}
export interface SkillCatalogObservation{protocol:1;complete:boolean;items:SkillCatalogItem[];catalogSha256:string;execution_authorized:false}
export interface SkillResourceView{protocol:1;name:string;relativePath:string;text:string;textSha256:string;execution_authorized:false}
export function skillManifest(value:unknown):SkillManifest;
export function validateSkillCatalogView(value:unknown):SkillCatalogObservation;
export function validateSkillResourceView(value:unknown):Promise<SkillResourceView>;
export function catalogDigestInput(value:SkillCatalogObservation):string;
