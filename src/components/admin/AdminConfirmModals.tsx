import { Button, Modal } from "@/components/ui";
import type { TravelTrip } from "@/lib/adminTypes";

export function AdminConfirmModals({
  deletingTrip,
  deleteBusy,
  confirmClear,
  onCloseDelete,
  onConfirmDelete,
  onCloseClear,
  onConfirmClear,
}: {
  deletingTrip: TravelTrip | null;
  deleteBusy: boolean;
  confirmClear: boolean;
  onCloseDelete: () => void;
  onConfirmDelete: () => void;
  onCloseClear: () => void;
  onConfirmClear: () => void;
}) {
  return (
    <>
      <Modal
        open={deletingTrip != null}
        onClose={onCloseDelete}
        title="Аяллыг устгах уу?"
        description={`"${deletingTrip?.route_name || deletingTrip?.operator_name}" - энэ үйлдлийг буцаах боломжгүй.`}
        footer={
          <>
            <Button variant="secondary" onClick={onCloseDelete}>
              Болих
            </Button>
            <Button variant="danger" loading={deleteBusy} onClick={onConfirmDelete}>
              Устгах
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">
          Устгасны дараа бот энэ аяллын мэдээллийг хариултдаа ашиглахгүй болно.
        </p>
      </Modal>

      <Modal
        open={confirmClear}
        onClose={onCloseClear}
        title="Текст цэвэрлэх үү?"
        description="Түлхүүр үгийн хариу, FAQ, тусгай санал болон бусад мэдээллийг устгана."
        footer={
          <>
            <Button variant="secondary" onClick={onCloseClear}>
              Болих
            </Button>
            <Button variant="danger" onClick={onConfirmClear}>
              Цэвэрлэх
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">
          Системийн зааварчилга болон бизнесийн нэр хадгалагдана.
        </p>
      </Modal>
    </>
  );
}
