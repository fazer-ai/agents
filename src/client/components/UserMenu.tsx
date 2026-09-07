import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ChevronDown,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Sun,
  UserRound,
} from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useToast } from "@/client/components/Toast";
import { useAuth } from "@/client/contexts/AuthContext";
import { useTheme } from "@/client/contexts/ThemeContext";
import { LANGUAGES } from "@/client/lib/languages";
import { afterLogout } from "@/client/lib/logout";
import { cn } from "@/client/lib/utils";

// t('theme.auto', 'Auto')
// t('theme.light', 'Light')
// t('theme.dark', 'Dark')
const THEME_OPTIONS = [
  { value: "auto" as const, icon: Monitor, labelKey: "theme.auto" },
  { value: "light" as const, icon: Sun, labelKey: "theme.light" },
  { value: "dark" as const, icon: Moon, labelKey: "theme.dark" },
];

const menuItemCls =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-secondary outline-none transition-colors data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary data-[state=checked]:text-text-primary";

const menuLabelCls = "px-2 py-1 font-medium text-text-muted text-xs uppercase";

export function UserMenu() {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const emailLabelId = useId();

  const handleLogout = async () =>
    // ONLY WHEN THE SESSION ACTUALLY ENDED. The cookie is HttpOnly, so a logout the server did not
    // answer leaves the operator signed in, and navigating anyway sends them to `/login`, which
    // bounces a signed-in visitor to `redirectTo`: the route they were on, gone, with nothing saying
    // why. The decision is `afterLogout` and not an `if` here, because the consent page makes the
    // same one.
    afterLogout(
      await logout(),
      () => navigate("/login"),
      () =>
        showToast(
          t("auth.logoutFailed", "Could not sign you out. Please try again."),
          "error",
        ),
    );

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          // NOTE: fallback to `nav.userMenu` when email is missing (auth
          // bootstrap or partial-user states) so the trigger always has an
          // accessible name. When present, `aria-labelledby` wins over
          // `aria-label` and exposes the visible email instead.
          aria-label={t("nav.userMenu", "User menu")}
          aria-labelledby={user?.email ? emailLabelId : undefined}
          className="group inline-flex items-center gap-2 rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary data-[state=open]:bg-bg-hover data-[state=open]:text-text-primary"
        >
          <span
            aria-hidden="true"
            className="flex h-6 w-6 items-center justify-center rounded-full bg-bg-primary text-text-primary"
          >
            <UserRound className="h-4 w-4" />
          </span>
          {user?.email && (
            <span
              id={emailLabelId}
              className="hidden max-w-45 truncate sm:inline"
            >
              {user.email}
            </span>
          )}
          <ChevronDown
            aria-hidden="true"
            className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180"
          />
        </button>
      </DropdownMenuPrimitive.Trigger>

      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={6}
          className="data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 z-(--z-dropdown) min-w-56 overflow-hidden rounded-lg border border-border bg-bg-secondary p-1 shadow-lg data-[state=closed]:animate-out data-[state=open]:animate-in"
        >
          <DropdownMenuPrimitive.Label className={menuLabelCls}>
            {t("theme.label", "Theme")}
          </DropdownMenuPrimitive.Label>
          <DropdownMenuPrimitive.RadioGroup
            value={theme}
            onValueChange={(value) => setTheme(value as typeof theme)}
          >
            {THEME_OPTIONS.map(({ value, icon: Icon, labelKey }) => {
              const selected = value === theme;
              return (
                <DropdownMenuPrimitive.RadioItem
                  key={value}
                  value={value}
                  className={cn(menuItemCls, {
                    "bg-bg-tertiary": selected,
                  })}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {/* biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in THEME_OPTIONS */}
                  <span className="flex-1">{t(labelKey)}</span>
                  {selected && (
                    <Check
                      className="ml-auto h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                </DropdownMenuPrimitive.RadioItem>
              );
            })}
          </DropdownMenuPrimitive.RadioGroup>

          <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />

          <DropdownMenuPrimitive.Label className={menuLabelCls}>
            {t("language.label", "Language")}
          </DropdownMenuPrimitive.Label>
          <DropdownMenuPrimitive.RadioGroup
            value={i18n.language}
            onValueChange={(value) => i18n.changeLanguage(value)}
          >
            {LANGUAGES.map((lang) => {
              const selected = lang.code === i18n.language;
              return (
                <DropdownMenuPrimitive.RadioItem
                  key={lang.code}
                  value={lang.code}
                  className={cn(menuItemCls, {
                    "bg-bg-tertiary": selected,
                  })}
                >
                  <span className="text-base" aria-hidden="true">
                    {lang.flag}
                  </span>
                  <span className="flex-1">{lang.name}</span>
                  {selected && (
                    <Check
                      className="ml-auto h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                </DropdownMenuPrimitive.RadioItem>
              );
            })}
          </DropdownMenuPrimitive.RadioGroup>

          <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />

          <DropdownMenuPrimitive.Item
            onSelect={() => navigate("/settings")}
            className={menuItemCls}
          >
            <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t("nav.settings", "Settings")}</span>
          </DropdownMenuPrimitive.Item>

          <DropdownMenuPrimitive.Item
            onSelect={handleLogout}
            className={menuItemCls}
          >
            <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t("auth.logout", "Logout")}</span>
          </DropdownMenuPrimitive.Item>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
