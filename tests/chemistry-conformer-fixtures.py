"""Numerical and rejection-path regressions run by chemistry-conformer.test.ts."""
import importlib.util
import math
import sys
from pathlib import Path
from unittest.mock import patch

import numpy as np
from rdkit import Chem
from rdkit.Chem import AllChem, rdMolTransforms

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("chemistry_conformer", Path(__file__).parents[1] / "scripts/chemistry-conformer.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def payload(smiles):
    return {"molfile": Chem.MolToMolBlock(Chem.MolFromSmiles(smiles))}


phase = np.arange(6) * np.pi / 3
chair = np.column_stack((1.2 * np.cos(phase), 1.2 * np.sin(phase), (-1.) ** np.arange(6) * .25))
planar = chair.copy()
planar[:, 2] = 0
assert helper.ring_geometry(chair)["shape"] == "chair"
assert helper.ring_geometry(planar)["shape"] == "near-planar"
flipped = chair.copy()
flipped[:, 2] *= -1
assert helper.ring_geometry(chair)["chairBasin"] != helper.ring_geometry(flipped)["chairBasin"]
# Frozen coordinates of the previously displayed, converged MMFF94 local
# minimum for Br[C@H]1[C@H](C)CCCC1. Its mixed torsion signs must reject chair.
twist = [[.226906, 1.215504, -.443504], [.914625, .094365, .361448],
         [.279806, -1.264120, .039982], [-1.205215, -1.301465, .408074],
         [-1.906471, .050939, .273906], [-1.242520, .934225, -.776746]]
classified = helper.ring_geometry(twist)
assert classified["shape"] == "non-chair"
assert 89 < classified["theta"] < 93
assert helper.ring_geometry([[0, 0, 0]] * 6) is None
# A rigid rotation/translation cannot turn a non-chair into a chair or swap
# chair basins. An independent RDKit calculation checks torsion convention.
rotation = np.array([[0., 0., 1.], [1., 0., 0.], [0., 1., 0.]])
for points in [chair, planar, twist]:
    original = helper.ring_geometry(points)
    moved = helper.ring_geometry(np.array(points) @ rotation + [5, -2, 3])
    assert original["shape"] == moved["shape"]
    assert original.get("chairBasin") == moved.get("chairBasin")
    assert abs(original["amplitude"] - moved["amplitude"]) < 1e-8
    conf = Chem.Conformer(6)
    for index, point in enumerate(points):
        conf.SetAtomPosition(index, point)
    for i, torsion in enumerate(original["torsions"]):
        assert abs(torsion - rdMolTransforms.GetDihedralDeg(conf, i, (i+1)%6, (i+2)%6, (i+3)%6)) < 1e-7
# Aromatic, unsaturated, heteroatom, fused, and spiro rings are unclassified.
for smiles in ["c1ccccc1", "C1CC=CCC1", "C1COCCC1", "C1CCC2CCCCC2C1", "C1CCC2(CC1)CCCCC2"]:
    assert helper.eligible_rings(Chem.MolFromSmiles(smiles)) == [], smiles
assert len(helper.eligible_rings(Chem.MolFromSmiles("CC1CCCCC1"))) == 1

# Match the complete group bonded to the ring, not just its first element.
# Repeated groups remain separate attachments, without invented ring numbering.
for smiles, label in [("FC1CCCCC1", "F"), ("ClC1CCCCC1", "Cl"), ("BrC1CCCCC1", "Br"),
                      ("IC1CCCCC1", "I"), ("CC1CCCCC1", "Me"), ("CCC1CCCCC1", "Et"),
                      ("OC1CCCCC1", "OH"), ("COC1CCCCC1", "OMe"), ("NC1CCCCC1", "NH2")]:
    mol = Chem.AddHs(Chem.MolFromSmiles(smiles))
    ring = helper.eligible_rings(mol)[0]
    groups = helper.simple_ring_substituents(mol, ring)
    assert [group["label"] for group in groups] == [label], smiles
    assert groups[0]["atomIndex"] in ring
    assert groups[0]["substituentAtomIndex"] not in ring
    assert mol.GetBondBetweenAtoms(groups[0]["atomIndex"], groups[0]["substituentAtomIndex"]) is not None
mapped = Chem.AddHs(Chem.MolFromSmiles("[CH3:1][CH:2]1CCCCC1"))
original_maps = [atom.GetAtomMapNum() for atom in mapped.GetAtoms()]
mapped_groups = helper.simple_ring_substituents(mapped, helper.eligible_rings(mapped)[0])
assert mapped_groups == [{"atomIndex": 1, "substituentAtomIndex": 0, "label": "Me"}]
assert [atom.GetAtomMapNum() for atom in mapped.GetAtoms()] == original_maps
for smiles in ["C1CCCCC1", "CCCC1CCCCC1", "CC1CCCCC1OCC", "C1CCCCC1C2CCCCC2",
               "[13CH3]C1CCCCC1", "C[13CH]1CCCCC1", "[2H]C1CCCCC1",
               "[NH3+]C1CCCCC1", "[CH2]C1CCCCC1", "C[C@H](O)C1CCCCC1"]:
    mol = Chem.AddHs(Chem.MolFromSmiles(smiles))
    assert all(helper.simple_ring_substituents(mol, ring) is None
               for ring in helper.eligible_rings(mol)), smiles

# Check tetrahedral and double-bond stereo against actual bad coordinates,
# independent of the embedded molecule's existing stereo tags.
for smiles in ["C[C@H](O)CC", "C/C=C/C", "C/C=C\\C"]:
    mol = Chem.AddHs(Chem.MolFromSmiles(smiles))
    expected = helper.stereo_signature(mol)
    params = AllChem.ETKDGv3()
    params.randomSeed = 0xC0DE
    assert AllChem.EmbedMolecule(mol, params) == 0
    assert helper.coordinates_preserve_stereo(mol, 0, expected)
    conf = mol.GetConformer()
    if "@" in smiles:
        for i in range(mol.GetNumAtoms()):
            x, y, z = conf.GetAtomPosition(i)
            conf.SetAtomPosition(i, (-x, y, z))
    else:
        angle = rdMolTransforms.GetDihedralDeg(conf, 0, 1, 2, 3)
        rdMolTransforms.SetDihedralDeg(conf, 0, 1, 2, 3, angle + 180)
    assert not helper.coordinates_preserve_stereo(mol, 0, expected), smiles

# An all-unconverged search must never report approximate energies as ranked
# minima. Unsupported parameterizations must never mix force fields.
with patch.object(helper, "optimize", return_value=("MMFF94", [(1, 1.0)] * 128)):
    try:
        helper.generate(payload("CCO"))
        raise AssertionError("Unconverged search incorrectly succeeded")
    except ValueError as error:
        assert "No converged conformer" in str(error)
with patch.object(AllChem, "MMFFHasAllMoleculeParams", return_value=False), patch.object(AllChem, "UFFHasAllMoleculeParams", return_value=False):
    try:
        helper.optimize(Chem.MolFromSmiles("CCO"))
        raise AssertionError("Unsupported force fields incorrectly succeeded")
    except ValueError as error:
        assert "Neither MMFF94 nor UFF" in str(error)
original_check = helper.coordinates_preserve_stereo
calls = 0

def reject_first(mol, conf_id, expected):
    global calls
    calls += 1
    return calls != 1 and original_check(mol, conf_id, expected)

with patch.object(helper, "coordinates_preserve_stereo", side_effect=reject_first):
    rejected = helper.generate(payload("CCO"))
    assert rejected["search"]["stereoRejected"] == 1
    assert "changed stereochemistry" in rejected["warning"]

result = helper.generate(payload("Br[C@H]1[C@H](C)CCCC1"))
molecules = [Chem.MolFromMolBlock(c["sdf"], removeHs=False) for c in result["conformers"]]
reference = molecules[0]
chairs = [c for c in result["conformers"] if c["rings"][0]["shape"] == "chair"]
assert len(chairs) == 2
assert [[(g["label"], g["orientation"]) for g in c["rings"][0]["substituents"]] for c in chairs] == [
    [("Br", "equatorial"), ("Me", "equatorial")], [("Br", "axial"), ("Me", "axial")]]
assert [[(g["atomIndex"], g["substituentAtomIndex"]) for g in c["rings"][0]["substituents"]] for c in chairs] == [
    [(1, 0), (2, 3)], [(1, 0), (2, 3)]]
assert all("substituents" not in c["rings"][0] for c in result["conformers"] if c["rings"][0]["shape"] != "chair")

# Independent plane fitting confirms that the assignments agree with actual
# bond directions, rather than just opposite signs of the chair pucker.
for c in chairs:
    mol = Chem.MolFromMolBlock(c["sdf"], removeHs=False)
    ring = tuple(c["rings"][0]["atomIndices"])
    conf = mol.GetConformer()
    points = np.array([list(conf.GetAtomPosition(i)) for i in ring])
    normal = np.linalg.svd(points - points.mean(axis=0))[2][-1]
    for group in c["rings"][0]["substituents"]:
        vector = np.array(conf.GetAtomPosition(group["substituentAtomIndex"])) - np.array(conf.GetAtomPosition(group["atomIndex"]))
        angle = math.degrees(math.asin(abs(vector @ normal) / np.linalg.norm(vector)))
        assert (angle < 35) if group["orientation"] == "equatorial" else (angle > 60)
    groups = helper.simple_ring_substituents(mol, ring)
    original = helper.chair_substituent_summary(mol, conf, ring, groups)
    for i in range(mol.GetNumAtoms()):
        conf.SetAtomPosition(i, np.array(conf.GetAtomPosition(i)) @ rotation + [5, -2, 3])
    assert helper.chair_substituent_summary(mol, conf, ring, groups) == original

# Distorted bonds, missing H, and non-chair rings cannot inherit confident
# orientations from otherwise familiar substituent names.
ring = tuple(result["conformers"][0]["rings"][0]["atomIndices"])
groups = helper.simple_ring_substituents(reference, ring)
attachment, substituent = groups[0]["atomIndex"], groups[0]["substituentAtomIndex"]
for distortion in ["ambiguous", "conflicting-pair", "zero-bond", "non-chair"]:
    mol = Chem.Mol(reference)
    conf = mol.GetConformer()
    points = np.array([list(conf.GetAtomPosition(i)) for i in ring])
    center = points.mean(axis=0)
    normal = np.linalg.svd(points - center)[2][-1]
    anchor = np.array(conf.GetAtomPosition(attachment))
    vector = np.array(conf.GetAtomPosition(substituent)) - anchor
    if distortion == "ambiguous":
        planar_vector = vector - (vector @ normal) * normal
        conf.SetAtomPosition(substituent, anchor + normal + planar_vector / np.linalg.norm(planar_vector))
    elif distortion == "conflicting-pair":
        hydrogen = next(atom.GetIdx() for atom in mol.GetAtomWithIdx(attachment).GetNeighbors() if atom.GetAtomicNum() == 1)
        conf.SetAtomPosition(hydrogen, anchor + vector / np.linalg.norm(vector))
    elif distortion == "zero-bond":
        conf.SetAtomPosition(substituent, anchor)
    else:
        for index in ring:
            point = np.array(conf.GetAtomPosition(index))
            conf.SetAtomPosition(index, point - ((point - center) @ normal) * normal)
    assert helper.chair_substituent_summary(mol, conf, ring, groups) is None, distortion
no_hydrogens = Chem.RemoveHs(reference)
assert helper.chair_substituent_summary(no_hydrogens, no_hydrogens.GetConformer(), ring, groups) is None

# A cis vicinal pair must stay mixed in both chair basins. A geminal pair has
# one axial and one equatorial group at the same carbon, without lost entries.
for smiles, expected_labels in [("Br[C@H]1[C@@H](C)CCCC1", ["Br", "Me"]), ("CC1(C)CCCCC1", ["Me", "Me"])]:
    mixed_result = helper.generate(payload(smiles))
    expected_stereo = helper.stereo_signature(Chem.AddHs(Chem.MolFromSmiles(smiles)))
    mixed_chairs = [c for c in mixed_result["conformers"] if c["rings"][0]["shape"] == "chair"]
    assert len(mixed_chairs) == 2
    for conformer in mixed_chairs:
        summary = conformer["rings"][0]["substituents"]
        assert [g["label"] for g in summary] == expected_labels
        assert {g["orientation"] for g in summary} == {"axial", "equatorial"}
        mol = Chem.MolFromMolBlock(conformer["sdf"], removeHs=False)
        assert helper.coordinates_preserve_stereo(mol, 0, expected_stereo)
        if expected_labels == ["Me", "Me"]:
            assert summary[0]["atomIndex"] == summary[1]["atomIndex"]
            assert summary[0]["substituentAtomIndex"] != summary[1]["substituentAtomIndex"]
atom_map = [(a.GetIdx(), a.GetIdx()) for a in reference.GetAtoms() if a.GetAtomicNum() > 1]
for mol in molecules[1:]:
    # Returned SDF coordinates already share the first conformer's frame. A new
    # proper alignment with that same map should add essentially no correction.
    squared = sum((mol.GetConformer().GetAtomPosition(i) - reference.GetConformer().GetAtomPosition(j)).LengthSq() for i,j in atom_map)
    raw_rms = math.sqrt(squared / len(atom_map))
    best_rms = AllChem.AlignMol(mol, reference, atomMap=atom_map, reflect=False)
    assert abs(raw_rms - best_rms) < 1e-5
for i, (left, a) in enumerate(zip(molecules, result["conformers"])):
    for right, b in zip(molecules[:i], result["conformers"][:i]):
        if a["rings"][0].get("chairBasin") == b["rings"][0].get("chairBasin"):
            rms = AllChem.GetBestRMS(Chem.RemoveHs(left), Chem.RemoveHs(right), maxMatches=1000)
            assert rms >= helper.RMSD_THRESHOLD - 1e-3
print("Geometry fixtures, axial/equatorial summaries, stereo rejection, convergence, aligned frames, and heavy-atom dedup passed.")
