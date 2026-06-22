import HistoryScreen from '../../src/screens/HistoryScreen';
import { LockGate } from '../../src/components/LockGate';

/** History tab, protected by App Lock when the user enables it in Settings. */
export default function History() {
  return (
    <LockGate label="History">
      <HistoryScreen />
    </LockGate>
  );
}
