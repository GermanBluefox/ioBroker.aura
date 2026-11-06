import { RefreshCw } from 'lucide-react';
import { getSettingsGroups, getText, resolveManifestUrl } from '@iobroker/web-components';
import { useConfigStore } from '../../store/configStore';
import { typedSettings } from '../../utils/webComponentHost';
import { findWebComponent, useWebComponentCatalog } from '../../utils/webComponentRegistry';
import {
    WebComponentFields,
    wcHintStyle as hintSty,
    wcInputCls as iCls,
    wcInputStyle as iSty,
    wcLabelCls as labelCls,
    type WebComponentLang,
} from './WebComponentFields';

interface Props {
    options: Record<string, unknown>;
    onChange: (patch: Record<string, unknown>) => void;
}

/**
 * Settings of the webcomponent widget: which component of which adapter, and its
 * own settings as its manifest declares them (a subset of JSON-Config). Values
 * are stored in `options.wcSettings`, only what the user set - the defaults of
 * the manifest fill in the rest when the element gets them. The fields are those
 * of the form dialogs a component opens at runtime (WebComponentFields).
 */
export function WebComponentConfig({ options: o, onChange }: Props) {
    const lang = useConfigStore((s) => s.frontend.language ?? 'de') as WebComponentLang;
    const { components, loading, reload } = useWebComponentCatalog();
    const component = findWebComponent(components, o.wcTag, o.wcAdapter);
    const stored = (o.wcSettings && typeof o.wcSettings === 'object' ? o.wcSettings : {}) as Record<string, unknown>;
    const data = component ? (typedSettings(component.manifest, stored) as Record<string, unknown>) : {};

    const setValue = (key: string, value: unknown): void => {
        const next = { ...stored };
        if (value === undefined || value === '') delete next[key];
        else next[key] = value;
        onChange({ wcSettings: next });
    };

    const choice = component ? `${component.adapter}|${component.manifest.tag}` : '';
    const icon = component ? resolveManifestUrl(component.manifest.icon, component.url) : undefined;

    return (
        <>
            <div>
                <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>
                    Komponente
                </label>
                <div className="flex gap-1">
                    <select
                        value={choice}
                        onChange={(e) => {
                            const [adapter, tag] = e.target.value.split('|');
                            if (tag === o.wcTag && adapter === o.wcAdapter) return;
                            onChange({ wcTag: tag || undefined, wcAdapter: adapter || undefined, wcSettings: {} });
                        }}
                        className={`${iCls} flex-1 min-w-0`}
                        style={iSty}
                    >
                        <option value="">{loading ? 'Lade…' : '– wählen –'}</option>
                        {typeof o.wcTag === 'string' && o.wcTag && !component && (
                            <option value={`${String(o.wcAdapter ?? '')}|${o.wcTag}`}>
                                {o.wcTag} (nicht installiert)
                            </option>
                        )}
                        {components.map((c) => (
                            <option key={`${c.adapter}|${c.manifest.tag}`} value={`${c.adapter}|${c.manifest.tag}`}>
                                {c.adapter}: {getText(c.manifest.name, lang) || c.manifest.tag}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        onClick={reload}
                        className="px-2 rounded-lg hover:opacity-80 shrink-0"
                        style={{ ...iSty, color: 'var(--text-secondary)' }}
                        title="Komponenten neu einlesen"
                    >
                        <RefreshCw size={13} />
                    </button>
                </div>
                {!loading && !components.length && (
                    <p className="text-[10px] mt-0.5" style={hintSty}>
                        Kein installierter Adapter bietet Web-Komponenten an (io-package: common.webComponents).
                    </p>
                )}
                {component && (
                    <div className="flex gap-2 items-start mt-1.5">
                        {icon && <img src={icon} alt="" className="w-6 h-6 object-contain shrink-0" />}
                        <p className="text-[10px]" style={hintSty}>
                            {getText(component.manifest.description, lang)}{' '}
                            <span className="font-mono">&lt;{component.manifest.tag}&gt;</span>
                        </p>
                    </div>
                )}
            </div>

            {component &&
                getSettingsGroups(component.manifest).map((group) => (
                    <div key={group.name} className="space-y-2">
                        {group.label && (
                            <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                                {getText(group.label, lang)}
                            </p>
                        )}
                        <WebComponentFields items={group.panel.items} data={data} lang={lang} onSet={setValue} />
                    </div>
                ))}
        </>
    );
}
