import { characters } from '../display';
import type { Character } from '../types';

const legacyKey = 'water-mobile:character';
type CharacterStorage = Pick<Storage, 'getItem' | 'removeItem'>;

export async function restoreCharacter(current: string | null, storage: CharacterStorage, save: (value: Character) => Promise<Character>): Promise<Character> {
  if (current !== null) {
    try { storage.removeItem(legacyKey); } catch { /* 原生设置已保存，不依赖旧存储清理成功。 */ }
    return characters.find(item => item.id === current)?.id ?? 'robot';
  }
  let previous: Character | undefined;
  try {
    const saved = storage.getItem(legacyKey);
    previous = characters.find(item => item.id === saved)?.id;
  }
  catch { return 'robot'; }
  if (!previous) return 'robot';
  // 原生保存成功后才移除旧值，失败时下次启动还能重试迁移。
  const selected = await save(previous);
  try { storage.removeItem(legacyKey); } catch { /* 下次启动以原生设置为准。 */ }
  return selected;
}
