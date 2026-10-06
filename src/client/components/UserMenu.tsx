import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Languages,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Sun,
} from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Avatar } from "@/client/components/Avatar";
import { RoleBadge } from "@/client/components/RoleBadge";
import { useToast } from "@/client/components/Toast";
import { useAuth } from "@/client/contexts/AuthContext";
import { useConfirmLeave } from "@/client/contexts/NavGuardContext";
import { useTheme } from "@/client/contexts/ThemeContext";
import { LANGUAGES } from "@/client/lib/languages";
import { afterLogout } from "@/client/lib/logout";
import { isAdminRole } from "@/client/lib/roles";
import { cn } from "@/client/lib/utils";

// t('theme.auto', 'Auto')
// t('theme.light', 'Light')
// t('theme.dark', 'Dark')
const AUTO_THEME = {
  value: "auto" as const,
  icon: Monitor,
  labelKey: "theme.auto",
};
const THEME_OPTIONS = [
  AUTO_THEME,
  { value: "light" as const, icon: Sun, labelKey: "theme.light" },
  { value: "dark" as const, icon: Moon, labelKey: "theme.dark" },
];

const menuItemCls =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-secondary outline-none transition-colors data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary data-[state=open]:bg-bg-hover data-[state=open]:text-text-primary";

const menuContentCls =
  "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 z-(--z-dropdown) overflow-hidden rounded-lg border border-border-hover bg-bg-secondary p-1 shadow-lg data-[state=closed]:animate-out data-[state=open]:animate-in";

const separatorCls = "-mx-1 my-1 h-px bg-border";

export function UserMenu() {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  // Both items leave the page in code, which the nav guard's link listener cannot see; a dirty
  // page form asks first.
  const confirmLeave = useConfirmLeave();
  const triggerLabelId = useId();
  const themeLabelId = useId();

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

  const email = user?.email ?? "";
  const displayName = user?.name?.trim() || email;
  const currentTheme =
    THEME_OPTIONS.find((option) => option.value === theme) ?? AUTO_THEME;
  const currentLanguage = LANGUAGES.find((l) => l.code === i18n.language);

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          // NOTE: fallback to `nav.userMenu` when email is missing (auth
          // bootstrap or partial-user states) so the trigger always has an
          // accessible name. When present, `aria-labelledby` wins over
          // `aria-label` and exposes the visible name (or email) instead.
          aria-label={t("nav.userMenu", "User menu")}
          aria-labelledby={email ? triggerLabelId : undefined}
          className="group inline-flex items-center gap-2 rounded-md py-1 pr-1.5 pl-1 text-sm text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary data-[state=open]:bg-bg-hover data-[state=open]:text-text-primary"
        >
          {email && <Avatar name={user?.name} email={email} size="sm" />}
          {email && (
            <span
              id={triggerLabelId}
              className="hidden max-w-40 truncate font-medium sm:inline"
            >
              {displayName}
            </span>
          )}
          <ChevronDown
            aria-hidden="true"
            className="h-3.5 w-3.5 text-text-muted transition-transform group-data-[state=open]:rotate-180"
          />
        </button>
      </DropdownMenuPrimitive.Trigger>

      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={6}
          className={cn(menuContentCls, "w-64")}
        >
          {email && (
            <>
              {/* Who is signed in, so an avatar-only trigger (mobile)
                  still has the name and email one tap away. Not an item: it
                  is skipped by arrow-key navigation. */}
              <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-2">
                <Avatar name={user?.name} email={email} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sm text-text-primary">
                    {displayName}
                  </p>
                  {user?.name?.trim() && (
                    <p className="truncate text-text-muted text-xs">{email}</p>
                  )}
                </div>
                {user && isAdminRole(user.role) && (
                  <RoleBadge role={user.role} className="shrink-0" />
                )}
              </div>
              <DropdownMenuPrimitive.Separator className={separatorCls} />
            </>
          )}

          {/* The three theme options sit in one row. Each is a radio item
              with its own accessible name, and the row's label spells out the
              current choice, so the icons never carry meaning alone. */}
          <div className="flex items-center justify-between gap-2 py-0.5 pr-0.5 pl-2">
            <span id={themeLabelId} className="text-sm text-text-secondary">
              {t("theme.label", "Theme")}
              <span className="text-text-muted">
                {" · "}
                {/* biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments above THEME_OPTIONS */}
                {t(currentTheme.labelKey)}
              </span>
            </span>
            <DropdownMenuPrimitive.RadioGroup
              value={theme}
              onValueChange={(value) => setTheme(value as typeof theme)}
              aria-labelledby={themeLabelId}
              className="flex gap-0.5 rounded-md border border-border bg-bg-tertiary p-0.5"
            >
              {THEME_OPTIONS.map(({ value, icon: Icon, labelKey }) => (
                <DropdownMenuPrimitive.RadioItem
                  key={value}
                  value={value}
                  // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments above THEME_OPTIONS
                  aria-label={t(labelKey)}
                  className="grid h-6 w-7 place-items-center rounded-sm text-text-muted outline-none transition-colors data-[highlighted]:bg-bg-hover data-[state=checked]:bg-bg-hover data-[highlighted]:text-text-primary data-[state=checked]:text-text-primary"
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                </DropdownMenuPrimitive.RadioItem>
              ))}
            </DropdownMenuPrimitive.RadioGroup>
          </div>

          <DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.SubTrigger className={menuItemCls}>
              <Languages className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="flex-1">{t("language.label", "Language")}</span>
              <span className="text-text-muted text-xs">
                {currentLanguage?.name}
              </span>
              <ChevronRight
                className="h-3.5 w-3.5 shrink-0 text-text-muted"
                aria-hidden="true"
              />
            </DropdownMenuPrimitive.SubTrigger>
            <DropdownMenuPrimitive.Portal>
              <DropdownMenuPrimitive.SubContent
                sideOffset={6}
                alignOffset={-5}
                className={cn(menuContentCls, "min-w-44")}
              >
                <DropdownMenuPrimitive.RadioGroup
                  value={i18n.language}
                  onValueChange={(value) => i18n.changeLanguage(value)}
                >
                  {LANGUAGES.map((lang) => (
                    <DropdownMenuPrimitive.RadioItem
                      key={lang.code}
                      value={lang.code}
                      className={menuItemCls}
                    >
                      <span className="text-base" aria-hidden="true">
                        {lang.flag}
                      </span>
                      <span className="flex-1">{lang.name}</span>
                      <DropdownMenuPrimitive.ItemIndicator>
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      </DropdownMenuPrimitive.ItemIndicator>
                    </DropdownMenuPrimitive.RadioItem>
                  ))}
                </DropdownMenuPrimitive.RadioGroup>
              </DropdownMenuPrimitive.SubContent>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Sub>

          <DropdownMenuPrimitive.Item
            onSelect={() => confirmLeave(() => navigate("/settings"))}
            className={menuItemCls}
          >
            <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t("nav.settings", "Settings")}</span>
          </DropdownMenuPrimitive.Item>

          <DropdownMenuPrimitive.Separator className={separatorCls} />

          <DropdownMenuPrimitive.Item
            onSelect={() => confirmLeave(() => void handleLogout())}
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
