import { PlayCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BulkActionBarProps {
  selectedTaskCount: number;
  selectedUploadGroupCount: number;
  onStartSelected: () => void;
  onClearSelection: () => void;
}

export function BulkActionBar({
  selectedTaskCount,
  selectedUploadGroupCount,
  onStartSelected,
  onClearSelection,
}: BulkActionBarProps) {
  const selectedCount = selectedTaskCount + selectedUploadGroupCount;
  if (selectedCount === 0) return null;

  return (
    <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background/95 px-3 py-2 shadow-sm backdrop-blur">
      <div className="text-sm">
        已选择 <span className="font-semibold">{selectedCount}</span> 项
        <span className="ml-2 text-xs text-muted-foreground">
          任务 {selectedTaskCount} · 归档组 {selectedUploadGroupCount}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onStartSelected}>
          <PlayCircle className="mr-1 h-4 w-4" />
          开始选中
        </Button>
        <Button variant="ghost" size="sm" onClick={onClearSelection}>
          <X className="mr-1 h-4 w-4" />
          清空选择
        </Button>
      </div>
    </div>
  );
}
