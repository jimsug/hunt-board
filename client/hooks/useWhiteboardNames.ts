import { Users, useTracker } from "client/store";
import { useTranslation } from "react-i18next";

// The display names of the people other users see on a board (by cursor,
// selection or typing), with "Someone" for a name not loaded. Keyed on who
// they are, so it only re-runs as people come and go.
export default function useWhiteboardNames(
  userIds: Iterable<string>,
): ReadonlyMap<string, string> {
  const { t } = useTranslation();
  const key = [...new Set(userIds)].toSorted().join(",");
  return useTracker(
    () =>
      new Map(
        (key ? key.split(",") : []).map((user) => [
          user,
          Users.findOne(user)?.displayName ??
            t("whiteboard.cursor.someone", "Someone"),
        ]),
      ),
    [key, t],
  );
}
