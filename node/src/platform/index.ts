// Escolhe a implementação do sistema em uso (DECK_PLATFORM força outra: testes).
import { OS } from '../env.ts';
import mac from './mac.ts';
import win from './win.ts';
import linux from './linux.ts';
import type { Platform } from './types.ts';
export type { AppInfo, Front, Key, Platform, Result } from './types.ts';

export const platform: Platform = OS === 'win32' ? win : OS === 'darwin' ? mac : linux;
