import { Users, useTracker } from "client/store";
import { useTranslation } from "react-i18next";

// Who each user is, for an AvatarStack.
export default function useAvatarUsers(ids: string[]) {
  const { t } = useTranslation();
  return useTracker(
    () =>
      ids.map((id) => {
        const user = Users.findOne(id);
        return {
          _id: id,
          displayName:
            user?.displayName ?? t("whiteboard.avatar.unknownUser", "Unknown"),
        };
      }),
    [ids, t],
  );
}
