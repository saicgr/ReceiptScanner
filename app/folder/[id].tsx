import FolderScreen from '../../src/screens/FolderScreen';
import { LockGate } from '../../src/components/LockGate';

/** Single-folder file browser, protected by App Lock like the rest of the archive. */
export default function Folder() {
  return (
    <LockGate label="Folders">
      <FolderScreen />
    </LockGate>
  );
}
