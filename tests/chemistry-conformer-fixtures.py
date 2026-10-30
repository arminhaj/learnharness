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
print("Geometry fixtures, stereo rejection, convergence, aligned frames, and heavy-atom dedup passed.")
