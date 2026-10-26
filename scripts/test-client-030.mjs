// Isolated compatibility helpers; no Git-history or hosted-backend dependency.
import {fileURLToPath} from 'node:url';
import {CLIENT_PROTOCOL} from '../src/clientCompatibility.js';
export async function enableTestClient030(db){
 await db.query('select planner_private.set_client_writes(true,$1)',[CLIENT_PROTOCOL]);
 await db.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-planner-protocol':CLIENT_PROTOCOL})]);
}
export async function legacy029Client(){
 return {...await import('../fixtures/legacy-client/src/persistence.js'),...await import('../fixtures/legacy-client/src/plannerStore.js')};
}
export async function legacy029Frontend(){return fileURLToPath(new URL('../fixtures/legacy-client/',import.meta.url));}
