import {DatabaseSync} from 'node:sqlite';
import {upgradeWorkspacePublicationCoordination} from '../../../src/workbench/workspace-coordination-upgrade.ts';
const db=new DatabaseSync(process.argv[2]);db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=75');
upgradeWorkspacePublicationCoordination(db,{onPhase:phase=>{if(phase===process.argv[3])process.exit(88)}});
db.close();process.exit(0);
