import { Monitor, Moon, Rows2, Rows4, Sun } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl, Select } from "@/client/components";
import { type Density, useDensity } from "@/client/contexts/DensityContext";
import { useTheme } from "@/client/contexts/ThemeContext";
import { LANGUAGES } from "@/client/lib/languages";
import { SettingsRow, SettingsSection } from "./SettingsSection";

type ThemePreference = "auto" | "light" | "dark";

export function SettingsPreferencesPage() {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const { density, setDensity } = useDensity();
  const themeLabelId = useId();
  const densityLabelId = useId();
  const languageId = useId();

  return (
    <>
      <SettingsSection
        title={t("settings.appearance", "Appearance")}
        description={t(
          "settings.appearanceDescription",
          "Saved in this browser only.",
        )}
      >
        <SettingsRow
          labelId={themeLabelId}
          label={t("theme.label", "Theme")}
          description={t(
            "settings.themeHint",
            "Choose light, dark, or follow your system.",
          )}
        >
          <SegmentedControl<ThemePreference>
            aria-labelledby={themeLabelId}
            value={theme}
            onChange={setTheme}
            options={[
              { value: "auto", label: t("theme.auto", "Auto"), icon: Monitor },
              { value: "light", label: t("theme.light", "Light"), icon: Sun },
              { value: "dark", label: t("theme.dark", "Dark"), icon: Moon },
            ]}
          />
        </SettingsRow>
        <SettingsRow
          labelId={densityLabelId}
          label={t("settings.density", "Density")}
          description={t(
            "settings.densityHint",
            "Compact fits more on screen. Comfortable makes text and controls larger.",
          )}
        >
          <SegmentedControl<Density>
            aria-labelledby={densityLabelId}
            value={density}
            onChange={setDensity}
            options={[
              {
                value: "compact",
                label: t("settings.densityCompact", "Compact"),
                icon: Rows4,
              },
              {
                value: "comfortable",
                label: t("settings.densityComfortable", "Comfortable"),
                icon: Rows2,
              },
            ]}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("language.label", "Language")}>
        <SettingsRow
          label={
            <label htmlFor={languageId}>
              {t("settings.interfaceLanguage", "Interface language")}
            </label>
          }
          description={t(
            "settings.languageHint",
            "Applies instantly across the app.",
          )}
        >
          <div className="@lg:w-56">
            <Select
              id={languageId}
              value={i18n.language}
              onChange={(e) => void i18n.changeLanguage(e.target.value)}
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {`${lang.flag} ${lang.name}`}
                </option>
              ))}
            </Select>
          </div>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
