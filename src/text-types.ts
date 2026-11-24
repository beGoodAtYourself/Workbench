import type {TextHighlight} from './text-highlights';
import type {Fault} from './types';
import type {TextEncoding} from './text-encodings';
export type {TextEncoding} from './text-encodings';
export type TextEol='lf'|'crlf'|'cr'|'mixed';
export interface TextFile {id:string;path:string;name:string;text:string;version:string;size:number;encoding:TextEncoding;eol:TextEol;readonly:boolean;highlights?:TextHighlight[]}
/** A probe performs the same strict read checks while omitting unchanged body IPC. */
export type TextProbeResult={kind:'unchanged';id:string;version:string;size:number;readonly:boolean}|{kind:'changed';file:TextFile};
export interface TextRecord {
 id:string;path:string|null;name:string;text?:string;length:number;version:string;
 encoding:TextEncoding;eol:TextEol;revision:number;savedRevision:number;
 cursor:number;anchor:number;scroll:number;language:string;tabSize:number;indentWithTabs:boolean;wrap:boolean;
 highlights?:TextHighlight[];readonly?:boolean;error?:Fault|null;
}
export interface TextSnapshot {schema:1;generation:number;documents:TextRecord[];views:string[];active:number;warning?:string}
export interface TextCommit {generation:number;token:string;warning?:string}
export interface TextSave {id:string;text:string;version:string;encoding:TextEncoding;eol:TextEol}
export interface TextOpenResult {files:TextFile[];errors:Fault[];notes:string[]}
export interface TextRepository {
 open(encoding?:TextEncoding):Promise<TextOpenResult>;
 openDropped?(token:string):Promise<TextOpenResult>;
 read(id:string,encoding?:TextEncoding):Promise<TextFile>;
 probe(id:string,knownVersion:string):Promise<TextProbeResult>;
 save(value:TextSave):Promise<TextFile>;
 saveAs(value:TextSave):Promise<TextFile|null>;
 restore():Promise<TextSnapshot>;
 recover(id:string):Promise<string>;
 checkpoint(value:TextSnapshot):Promise<TextCommit>;
 invalidate(generation:number):Promise<void>;
 close(id:string):Promise<void>;
 notes(paths:string[]):Promise<void>;
 noteOwner(path:string):Promise<string|null>;
}
export const MAX_TEXT_TABS=12,MAX_TEXT_LENGTH=16*1024*1024;
