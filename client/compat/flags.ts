import { welcome } from "client/store/current";

// Jolly Roger's feature flags, as far as the board reads them: the welcome
// says which are on.
const Flags = {
  active(name: string): boolean {
    return welcome.get()?.flags?.includes(name) ?? false;
  },
};

export default Flags;
