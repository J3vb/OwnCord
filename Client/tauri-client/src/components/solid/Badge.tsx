/**
 * Phase B Step 6 — first Solid.js leaf component.
 *
 * Trivial proof-of-concept badge used by other Solid components and the
 * mount helper. Self-contained: no store subscriptions, no async work, just
 * a presentational element. Use it as the canonical example when migrating
 * vanilla badge/pill components in the rest of the tree.
 */

import type { JSX } from "solid-js";

export interface BadgeProps {
  label: string;
  /** Visual variant; defaults to "neutral". */
  variant?: "neutral" | "online" | "idle" | "dnd" | "offline";
  /** Optional click handler. When set the badge gains role="button". */
  onClick?: () => void;
}

const variantClass: Record<NonNullable<BadgeProps["variant"]>, string> = {
  neutral: "badge",
  online: "badge badge--online",
  idle: "badge badge--idle",
  dnd: "badge badge--dnd",
  offline: "badge badge--offline",
};

export function Badge(props: BadgeProps): JSX.Element {
  const cls = () => variantClass[props.variant ?? "neutral"];
  return (
    <span
      class={cls()}
      role={props.onClick ? "button" : undefined}
      tabIndex={props.onClick ? 0 : undefined}
      onClick={props.onClick}
      onKeyDown={(e) => {
        if (props.onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          props.onClick();
        }
      }}
    >
      {props.label}
    </span>
  );
}
