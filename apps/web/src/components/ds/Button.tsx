import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = { primary: "btn-primary", secondary: "", ghost: "btn-ghost", danger: "btn-danger" };
const SIZE: Record<ButtonSize, string> = { sm: "btn-sm", md: "", lg: "btn-lg" };

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and disables the button. The label stays visible (never "Done" before success). */
  loading?: boolean;
  /** Optional text shown while loading, e.g. "Applying…". Defaults to the normal children. */
  loadingText?: ReactNode;
  icon?: IconName;
};

/** Thin wrapper over the global .btn classes. Defaults to type="button" so it never submits a form by accident. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, loadingText, icon, className = "", disabled, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`btn ${VARIANT[variant]} ${SIZE[size]} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Icon name="spinner" size={13} /> : icon ? <Icon name={icon} size={13} /> : null}
      {loading && loadingText ? loadingText : children}
    </button>
  );
});

export type IconButtonProps = Omit<ButtonProps, "children" | "icon" | "loadingText"> & {
  icon: IconName;
  /** Required accessible name; also shown as the native tooltip. */
  label: string;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = "ghost", size = "md", loading, className = "", title, ...rest },
  ref,
) {
  return (
    <Button ref={ref} variant={variant} size={size} loading={loading} aria-label={label} title={title ?? label} className={`btn-icon ${className}`} {...rest}>
      {loading ? null : <Icon name={icon} size={size === "sm" ? 13 : 15} />}
    </Button>
  );
});
