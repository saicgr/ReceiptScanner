import StatisticsScreen from '../../src/screens/StatisticsScreen';
import { LockGate } from '../../src/components/LockGate';

/** Statistics tab, protected by App Lock when the user enables it in Settings. */
export default function Statistics() {
  return (
    <LockGate label="Statistics">
      <StatisticsScreen />
    </LockGate>
  );
}
