import { defineClientStateContributor } from '../../clientSync/contributors';
import { compressionStateProjectionReads, projectCompressionState } from './stateProjection';

export const projectCompressionClientState = projectCompressionState;

export const compressionClientSyncContributor = defineClientStateContributor({
  key: 'compression',
  tables: ['compressionBlocks', 'compressionBlockSourceLinks', 'compressionContextVariants', 'runCompressionBlockLinks'],
  reads: compressionStateProjectionReads,
  project: projectCompressionClientState,
  worker: {
    modulePath: '../world/modules/compression/clientSync',
    projectExport: 'projectCompressionClientState'
  }
});
