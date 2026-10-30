"""Bounded local conformer search. Input arrives on stdin, never in a shell.

Only converged minima of one force field and one stereoisomer are compared.
The ensemble is a reproducible sample, not an exhaustive conformational search.
"""
import json
import math
import sys

REQUESTED = 128
SEED = 0xC0DE
RMSD_THRESHOLD = 0.25
# Exact attachment fragments, rather than guesses based on the first atom.
# The wildcard is the severed bond to the ring; ordinary hydrogens are implicit.
SIMPLE_SUBSTITUENTS = {
    "*F": "F", "*Cl": "Cl", "*Br": "Br", "*I": "I",
    "*C": "Me", "*CC": "Et", "*O": "OH", "*OC": "OMe", "*N": "NH2",
}


def ring_geometry(points):
    """Cremer-Pople puckering plus torsions; None means degenerate geometry.

    A chair needs both a polar pucker (within 15 degrees of either pole) and
    alternating, substantial torsions. This deliberately avoids boat taxonomy.
    The normal and its sign depend only on fixed cyclic atom order, not camera.
    """
    import numpy as np

    points = np.asarray(points, dtype=float)
    if points.shape != (6, 3) or not np.isfinite(points).all():
        return None
    positions = points - points.mean(axis=0)
    phase = np.arange(6) * 2 * np.pi / 6
    normal = np.cross((positions * np.sin(phase)[:, None]).sum(axis=0),
                      (positions * np.cos(phase)[:, None]).sum(axis=0))
    length = np.linalg.norm(normal)
    if length < 1e-8:
        return None
    z = positions @ (normal / length)
    q2x = math.sqrt(1 / 3) * float((z * np.cos(2 * phase)).sum())
    q2y = -math.sqrt(1 / 3) * float((z * np.sin(2 * phase)).sum())
    q3 = float((z * (-1.0) ** np.arange(6)).sum()) / math.sqrt(6)
    q2 = math.hypot(q2x, q2y)
    amplitude = math.hypot(q2, q3)
    theta = math.degrees(math.atan2(q2, q3)) if amplitude > 1e-8 else 90.0
    torsions = []
    for i in range(6):
        p0, p1, p2, p3 = [points[(i + offset) % 6] for offset in range(4)]
        axis = p2 - p1
        norm = np.linalg.norm(axis)
        if norm < 1e-8:
            return None
        axis = axis / norm
        v = p0 - p1 - np.dot(p0 - p1, axis) * axis
        w = p3 - p2 - np.dot(p3 - p2, axis) * axis
        if min(np.linalg.norm(v), np.linalg.norm(w)) < 1e-8:
            return None
        torsions.append(math.degrees(math.atan2(np.dot(np.cross(axis, v), w), np.dot(v, w))))
    alternating = all(torsions[i] * torsions[(i + 1) % 6] < 0 for i in range(6))
    chair = (min(theta, 180 - theta) <= 15 and alternating
             and all(35 <= abs(angle) <= 80 for angle in torsions))
    shape = "near-planar" if amplitude < 0.1 else "chair" if chair else "non-chair"
    result = {"shape": shape, "theta": theta, "amplitude": amplitude, "torsions": torsions}
    if shape == "chair":
        result["chairBasin"] = "positive" if q3 > 0 else "negative"
    return result


def eligible_rings(mol):
    from rdkit import Chem

    info = mol.GetRingInfo()
    rings = []
    for ring in info.AtomRings():
        if len(ring) != 6:
            continue
        if any(mol.GetAtomWithIdx(i).GetAtomicNum() != 6
               or mol.GetAtomWithIdx(i).GetIsAromatic()
               or mol.GetAtomWithIdx(i).GetHybridization() != Chem.HybridizationType.SP3
               or info.NumAtomRings(i) != 1 for i in ring):
            continue
        if any(mol.GetBondBetweenAtoms(ring[i], ring[(i + 1) % 6]).GetBondType()
               != Chem.BondType.SINGLE for i in range(6)):
            continue
        # Canonicalize the cyclic order, preserving atom identities across flips.
        start = ring.index(min(ring))
        forward = ring[start:] + ring[:start]
        reverse = (forward[0],) + tuple(reversed(forward[1:]))
        rings.append(min(forward, reverse))
    return sorted(rings)


def simple_ring_substituents(mol, ring):
    """Complete, stable group identities for one simple cyclohexane, or None.

    Atom indices identify the same attachment across this ensemble; they are
    not course numbering. An unknown group suppresses the whole summary, so a
    partial list cannot look like a complete account of the substituents.
    """
    from rdkit import Chem

    if mol.GetRingInfo().NumRings() != 1 or tuple(ring) not in eligible_rings(mol):
        return None
    # Abbreviations must not hide isotope labels, charges, or radicals.
    if any(atom.GetIsotope() or atom.GetFormalCharge() or atom.GetNumRadicalElectrons()
           for atom in mol.GetAtoms()):
        return None
    groups = []
    for index in ring:
        for neighbor in mol.GetAtomWithIdx(index).GetNeighbors():
            external = neighbor.GetIdx()
            if external in ring or neighbor.GetAtomicNum() == 1:
                continue
            bond = mol.GetBondBetweenAtoms(index, external)
            if bond.GetBondType() != Chem.BondType.SINGLE:
                return None
            fragments = Chem.FragmentOnBonds(mol, [bond.GetIdx()], dummyLabels=[(0, 0)])
            mappings = []
            parts = Chem.GetMolFrags(fragments, asMols=True, fragsMolAtomMapping=mappings)
            part = next(part for part, indices in zip(parts, mappings) if external in indices)
            if any(atom.GetChiralTag() != Chem.ChiralType.CHI_UNSPECIFIED for atom in part.GetAtoms()):
                return None
            # Atom maps identify source atoms; they do not change group identity.
            # Clear them only on this detached copy, preserving the input/SDF.
            for atom in part.GetAtoms():
                atom.SetAtomMapNum(0)
            label = SIMPLE_SUBSTITUENTS.get(Chem.MolToSmiles(Chem.RemoveHs(part), isomericSmiles=True))
            if label is None:
                return None
            groups.append({"atomIndex": index, "substituentAtomIndex": external, "label": label})
    return sorted(groups, key=lambda group: (group["atomIndex"], group["substituentAtomIndex"])) or None


def chair_substituent_summary(mol, conf, ring, groups):
    """Conservative axial/equatorial assignment, independent of camera axes.

    Bond angles are measured from the Cremer-Pople ring mean plane: <=35
    degrees is equatorial, >=60 is axial, and the gap is intentionally unknown.
    Both external bonds at every carbon (including H) must agree on one of
    each. These are conformational orientations, never cis/trans assignments.
    """
    import numpy as np

    if not groups:
        return None
    points = np.asarray([list(conf.GetAtomPosition(i)) for i in ring])
    geometry = ring_geometry(points)
    if not geometry or geometry["shape"] != "chair":
        return None
    positions = points - points.mean(axis=0)
    phase = np.arange(6) * 2 * np.pi / 6
    normal = np.cross((positions * np.sin(phase)[:, None]).sum(axis=0),
                      (positions * np.cos(phase)[:, None]).sum(axis=0))
    normal /= np.linalg.norm(normal)
    orientations = {}
    for index in ring:
        external = [neighbor.GetIdx() for neighbor in mol.GetAtomWithIdx(index).GetNeighbors()
                    if neighbor.GetIdx() not in ring]
        # Generation adds explicit H before this function; incomplete imported
        # geometry must not bypass the paired-bond consistency check.
        if len(external) != 2:
            return None
        pair = []
        for neighbor in external:
            vector = np.asarray(conf.GetAtomPosition(neighbor)) - np.asarray(conf.GetAtomPosition(index))
            length = np.linalg.norm(vector)
            if not np.isfinite(vector).all() or length < 1e-8:
                return None
            angle = math.degrees(math.asin(float(np.clip(abs(vector @ normal) / length, 0, 1))))
            orientation = "equatorial" if angle <= 35 else "axial" if angle >= 60 else None
            if orientation is None:
                return None
            orientations[(index, neighbor)] = orientation
            pair.append(orientation)
        if set(pair) != {"axial", "equatorial"}:
            return None
    return [{**group, "orientation": orientations[(group["atomIndex"], group["substituentAtomIndex"])]}
            for group in groups]


def stereo_signature(mol):
    from rdkit import Chem

    Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
    atoms = {a.GetIdx(): a.GetProp("_CIPCode") for a in mol.GetAtoms() if a.HasProp("_CIPCode")}
    bonds = {b.GetIdx(): str(b.GetStereo()) for b in mol.GetBonds()
             if b.GetStereo() in (Chem.BondStereo.STEREOE, Chem.BondStereo.STEREOZ)}
    return atoms, bonds


def coordinates_preserve_stereo(mol, conf_id, expected):
    from rdkit import Chem

    checked = Chem.Mol(mol)
    Chem.AssignStereochemistryFrom3D(checked, confId=conf_id, replaceExistingTags=True)
    observed = stereo_signature(checked)
    return all(observed[kind].get(index) == value
               for kind in (0, 1) for index, value in expected[kind].items())


def optimize(mol):
    from rdkit.Chem import AllChem

    if AllChem.MMFFHasAllMoleculeParams(mol):
        return "MMFF94", AllChem.MMFFOptimizeMoleculeConfs(mol, numThreads=1, maxIters=1000, mmffVariant="MMFF94")
    if AllChem.UFFHasAllMoleculeParams(mol):
        return "UFF", AllChem.UFFOptimizeMoleculeConfs(mol, numThreads=1, maxIters=1000)
    raise ValueError("Neither MMFF94 nor UFF supports every atom in this structure; conformer energies cannot be ranked.")


def generate(payload):
    from rdkit import Chem
    from rdkit.Chem import AllChem
    from rdkit.Chem.EnumerateStereoisomers import EnumerateStereoisomers, StereoEnumerationOptions

    block = payload.get("molfile")
    if not isinstance(block, str) or len(block) > 200_000:
        raise ValueError("A valid Molfile is required for 3D generation.")
    mol = Chem.MolFromMolBlock(block, sanitize=True, removeHs=False)
    if mol is None or mol.GetNumAtoms() == 0:
        raise ValueError("This structure could not be read.")
    if mol.GetNumHeavyAtoms() > 200:
        raise ValueError("3D generation supports up to 200 non-hydrogen atoms.")
    if len(Chem.GetMolFrags(mol)) != 1:
        raise ValueError("View one connected molecule at a time in 3D.")
    # Relative/enhanced stereo groups are not single absolute stereoisomers.
    if any(group.GetGroupType() != Chem.StereoGroupType.STEREO_ABSOLUTE for group in mol.GetStereoGroups()):
        raise ValueError("Choose absolute stereochemistry before ranking a structure with relative stereo groups.")
    unspecified = any(info.specified != Chem.StereoSpecified.Specified for info in Chem.FindPotentialStereo(mol))
    if unspecified:
        # Rank conformers of just one deterministic assignment, never compare
        # energies across an unlabelled mixture of different stereoisomers.
        options = StereoEnumerationOptions(onlyUnassigned=True, maxIsomers=1, rand=SEED, tryEmbedding=False)
        mol = next(EnumerateStereoisomers(mol, options=options))
        if any(info.specified != Chem.StereoSpecified.Specified for info in Chem.FindPotentialStereo(mol)):
            raise ValueError("Specify the remaining stereochemistry before searching conformers.")
    mol.SetProp("_Name", "")
    mol = Chem.AddHs(mol)
    if mol.GetNumAtoms() > 512:
        raise ValueError("3D generation supports up to 512 atoms including hydrogens.")
    expected = stereo_signature(mol)
    isomeric_smiles = Chem.MolToSmiles(Chem.RemoveHs(mol), isomericSmiles=True)
    params = AllChem.ETKDGv3()
    params.randomSeed = SEED
    params.enforceChirality = True
    params.numThreads = 1
    params.maxIterations = 1000
    params.timeout = 2
    # Pruning before minimization can discard an opposite chair basin.
    params.pruneRmsThresh = -1.0
    ids = list(AllChem.EmbedMultipleConfs(mol, numConfs=REQUESTED, params=params))
    if not ids:
        raise ValueError("A 3D conformer could not be generated for this structure.")
    method, optimized = optimize(mol)
    rings = eligible_rings(mol)
    ring_groups = {ring: simple_ring_substituents(mol, ring) for ring in rings}
    converged = 0
    stereo_rejected = 0
    candidates = []
    for conf_id, (status, energy) in zip(ids, optimized):
        if status != 0 or not math.isfinite(energy):
            continue
        converged += 1
        if not coordinates_preserve_stereo(mol, conf_id, expected):
            stereo_rejected += 1
            continue
        conf = mol.GetConformer(conf_id)
        if not all(math.isfinite(value) for point in conf.GetPositions() for value in point):
            continue
        classifications = []
        for ring in rings:
            geometry = ring_geometry([list(conf.GetAtomPosition(i)) for i in ring])
            if geometry:
                substituents = chair_substituent_summary(mol, conf, ring, ring_groups[ring])
                if substituents:
                    geometry["substituents"] = substituents
                classifications.append({"atomIndices": list(ring), **geometry})
        candidates.append({"conf_id": conf_id, "energy": float(energy), "rings": classifications})
    if not candidates:
        raise ValueError("No converged conformer preserved the requested stereochemistry. Try a smaller or more fully specified structure.")
    candidates.sort(key=lambda item: (item["energy"], item["conf_id"]))
    # Symmetry-aware RMSD on heavy atoms, after optimization. Only a scratch
    # molecule is aligned by GetBestRMS. Keep opposing chair signs separate even
    # when molecular symmetry can superpose them (e.g. unsubstituted cyclohexane).
    heavy = Chem.RemoveHs(mol)
    unique = []
    for candidate in candidates:
        signature = tuple((tuple(r["atomIndices"]), r.get("chairBasin")) for r in candidate["rings"])
        duplicate = False
        for existing in unique:
            if signature != existing["signature"]:
                continue
            rmsd = AllChem.GetBestRMS(heavy, heavy, prbId=candidate["conf_id"], refId=existing["conf_id"], maxMatches=1000, numThreads=1)
            if rmsd < RMSD_THRESHOLD:
                duplicate = True
                break
        if not duplicate:
            unique.append({**candidate, "signature": signature})
    # A fixed atom map and proper rotation gives the viewer a common coordinate
    # frame while preserving identities and the distinction between ring flips.
    reference = unique[0]["conf_id"]
    atom_map = [(a.GetIdx(), a.GetIdx()) for a in mol.GetAtoms() if a.GetAtomicNum() > 1]
    conformers = []
    minimum = unique[0]["energy"]
    for rank, candidate in enumerate(unique):
        conf_id = candidate["conf_id"]
        if conf_id != reference:
            AllChem.AlignMol(mol, mol, prbCid=conf_id, refCid=reference, atomMap=atom_map, reflect=False)
        conformers.append({
            "id": f"conformer-{rank + 1}",
            "sdf": Chem.MolToMolBlock(mol, confId=conf_id) + "\n$$$$\n",
            "energy": candidate["energy"],
            "relativeEnergy": candidate["energy"] - minimum,
            "rings": candidate["rings"],
        })
    warnings = []
    if method == "UFF":
        warnings.append("MMFF94 does not support this structure; all conformers were optimized and ranked with UFF.")
    if unspecified:
        warnings.append("Stereochemistry is unspecified at one or more positions. This search uses one deterministic assignment; other stereoisomers were not compared.")
    if converged < len(ids):
        warnings.append(f"{len(ids) - converged} unconverged or invalid-energy candidates were excluded.")
    if stereo_rejected:
        warnings.append(f"{stereo_rejected} candidates that changed stereochemistry were excluded.")
    result = {"sdf": conformers[0]["sdf"], "generated": True, "conformers": conformers, "search": {
        "method": method, "requested": REQUESTED, "embedded": len(ids), "converged": converged,
        "stereoRejected": stereo_rejected, "unique": len(unique), "returned": len(conformers),
        "rmsdThreshold": RMSD_THRESHOLD, "seed": SEED,
        "stereochemistry": "assigned-for-search" if unspecified else "specified",
        "isomericSmiles": isomeric_smiles, "energyUnit": "kcal/mol", "exhaustive": False,
    }}
    if warnings:
        result["warning"] = " ".join(warnings)
    return result


if __name__ == "__main__":
    try:
        print(json.dumps(generate(json.loads(sys.stdin.read(250_001))), allow_nan=False))
    except ImportError:
        print(json.dumps({"error": "RDKit is missing from the local 3D helper. Run python3 scripts/setup-chemistry.py."}))
        sys.exit(2)
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
