import { useEffect, useState } from 'react';
import { OPENAI_RUNTIME_PREFIX } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';

/** The model the Chief of Staff plans with (a workspace setting; Haiku by default). */
export function PlanningModel({ disabled }: { disabled?: boolean }) {
  const { api } = useStore();
  const { t } = useI18n();
  const [value, setValue] = useState<string | null | undefined>(undefined);
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    api.getSettings().then((s) => setValue(s.intakeModel), () => setValue(null));
    api.listRuntimes().then((rs) => setModels([...new Set(rs.filter((r) => r.id !== 'mock' && !r.id.startsWith(OPENAI_RUNTIME_PREFIX)).flatMap((r) => r.models))]), () => setModels([]));
  }, [api]);

  if (value === undefined) return null;
  const options = [...new Set([...models, ...(value ? [value] : [])])];
  const change = async (next: string) => {
    const intakeModel = next || null;
    setValue(intakeModel);
    try { setValue((await api.updateSettings({ intakeModel })).intakeModel); } catch { /* keep the local choice */ }
  };

  return (
    <label className="planning-model">
      <span>{t('intake.model')}</span>
      <select className="input input--sm" value={value ?? ''} disabled={disabled} onChange={(e) => void change(e.target.value)}>
        <option value="">{t('intake.modelAgent')}</option>
        {options.map((m) => <option key={m} value={m}>{m === 'haiku' ? t('intake.modelHaiku') : m}</option>)}
      </select>
    </label>
  );
}
