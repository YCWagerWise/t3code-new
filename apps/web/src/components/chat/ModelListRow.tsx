import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { memo } from "react";
import { StarIcon } from "lucide-react";
import {
  getDisplayModelName,
  getTriggerDisplayModelLabel,
  type ModelEsque,
  PROVIDER_ICON_BY_PROVIDER,
} from "./providerIconUtils";
import { ComboboxItem } from "../ui/combobox";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  model: ModelEsque;
  /** Instance the model belongs to — the routing key used in combobox values. */
  instanceId: ProviderInstanceId;
  /** Driver kind of the instance — used for the provider icon glyph. */
  driverKind: ProviderDriverKind;
  /**
   * Display name to show in the secondary line (provider footer). Usually
   * the instance's configured `displayName` so custom instances like
   * "Codex Personal" render with their user-authored label.
   */
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  isFavorite: boolean;
  isSelected: boolean;
  showProvider: boolean;
  preferShortName?: boolean;
  useTriggerLabel?: boolean;
  showNewBadge?: boolean;
  jumpLabel?: string | null;
  disabledReason?: string | null;
  onToggleFavorite: () => void;
}) {
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null;
  // Strictly `=== false`. Absent means the provider never probed, and a badge on a
  // guess is worse than no badge — the model is still selectable either way, since a
  // tool-less model is a fine choice for a plain prompt.
  const lacksTools = props.model.capabilities?.supportsTools === false;
  const providerLabel = props.model.subProvider
    ? `${props.providerDisplayName} · ${props.model.subProvider}`
    : props.providerDisplayName;

  const row = (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={`${props.instanceId}:${props.model.slug}`}
      disabled={Boolean(props.disabledReason)}
      contentClassName="flex w-full items-center gap-3"
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer rounded-md px-2 py-2.5 transition-[background-color,box-shadow,color]",
        "hover:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))] data-highlighted:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))] data-selected:bg-foreground/[0.08] data-selected:text-foreground data-selected:ring-0 [&[data-highlighted][data-selected]]:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))]",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed data-disabled:hover:bg-transparent",
      )}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 truncate text-xs font-medium leading-snug">
            {props.useTriggerLabel
              ? getTriggerDisplayModelLabel(props.model)
              : getDisplayModelName(
                  props.model,
                  props.preferShortName ? { preferShortName: true } : undefined,
                )}
          </div>
          {props.showNewBadge ? (
            <span
              className="shrink-0 rounded border border-amber-500/35 bg-amber-500/15 px-0.5 py-px text-[10px] font-bold uppercase leading-none tracking-wide text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/12 dark:text-amber-200"
              aria-label="New model"
            >
              New
            </span>
          ) : null}
          {lacksTools ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className="shrink-0 rounded border border-muted-foreground/25 bg-muted-foreground/10 px-0.5 py-px text-[10px] font-bold uppercase leading-none tracking-wide text-muted-foreground"
                    aria-label="This model cannot call tools"
                  >
                    No tools
                  </span>
                }
              />
              <TooltipPopup
                side="top"
                align="center"
                className="max-w-64 text-balance leading-snug"
              >
                This model cannot call tools. It will answer, but it cannot run commands, read
                files, or edit code — and may describe doing so instead.
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
        {props.showProvider && (
          <div className="mt-1 flex items-center gap-1.5">
            {ProviderIcon ? <ProviderIcon className="size-3 shrink-0" /> : null}
            <span className="truncate text-xs font-normal leading-snug text-muted-foreground/70">
              {providerLabel}
            </span>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {props.jumpLabel ? (
          <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px]">{props.jumpLabel}</Kbd>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                className={cn(
                  "-mr-1 shrink-0 text-muted-foreground/70 opacity-64 transition-[color,opacity] hover:text-foreground hover:opacity-100 group-hover:opacity-100",
                  props.isFavorite && "text-foreground opacity-100",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onToggleFavorite();
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                }}
                disabled={Boolean(props.disabledReason)}
                aria-label={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
              >
                <StarIcon
                  className={cn(
                    "size-3.5 sm:size-3",
                    props.isFavorite && "fill-current text-yellow-500",
                  )}
                />
              </Button>
            }
          />
          <TooltipPopup side="top" align="center">
            {props.isFavorite ? "Remove from favorites" : "Add to favorites"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </ComboboxItem>
  );

  if (!props.disabledReason) {
    return row;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup side="left" align="center" className="max-w-64 text-balance leading-snug">
        {props.disabledReason}
      </TooltipPopup>
    </Tooltip>
  );
});
