export interface SkillManifest{name:string;description:string;whenToUse?:string;invocation:{modelInvocable:boolean;userInvocable:boolean};source:string;provider:string}
export interface SkillCatalogItem extends SkillManifest{}
export interface CommandManifest{name:string;description:string;definitionId?:string;input?:{hint:string;attachments?:boolean}}
export interface SkillCommandCatalog{available:boolean;items:CommandManifest[]}
export interface SkillCatalogObservation{protocol:1;complete:boolean;items:SkillCatalogItem[];catalogSha256:string;execution_authorized:false;commands?:SkillCommandCatalog}
export interface SkillResourceView{protocol:1;name:string;relativePath:string;text:string;textSha256:string;execution_authorized:false}
export interface SkillSourceManifest{version:string|null;license:string|null;source:'selected-skill-frontmatter';textSha256:string}
export interface SkillDefinitionView extends SkillManifest{protocol:1;content:string;bodySha256:string;manifest:{version:string|null;license:string|null;source:'native-provider-metadata';original?:SkillSourceManifest};definitionSha256:string;execution_authorized:false}
export function skillManifest(value:unknown):SkillManifest;
export function commandManifest(value:unknown):CommandManifest;
export function validateSkillCatalogView(value:unknown):SkillCatalogObservation;
export function validateSkillResourceView(value:unknown):Promise<SkillResourceView>;
export function catalogDigestInput(value:SkillCatalogObservation):string;
export function skillDefinitionDigestInput(value:SkillDefinitionView):string;
export function validateSkillDefinitionView(value:unknown):Promise<SkillDefinitionView>;
