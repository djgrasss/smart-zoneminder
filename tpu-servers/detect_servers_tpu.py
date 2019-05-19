"""
Detect objects and faces using tensorflow-tpu served by zerorpc.

This needs to be called from a zerorpc client with
an array of alarm frame image paths.

This is part of the smart-zoneminder project.
See https://github.com/goruck/smart-zoneminder

Copyright (c) 2018, 2019 Lindo St. Angel
"""

import numpy as np
import json
import zerorpc
import pickle
import cv2
import logging
import gevent
import face_recognition
from signal import SIGINT, SIGTERM
from edgetpu.detection.engine import DetectionEngine

logging.basicConfig(level=logging.ERROR)

# Open configuration file. 
with open('./config.json') as fp:
    config = json.load(fp)

obj_config = config['objDetServer']
face_config = config['faceDetServer']

### Object detection configuration. ###
# Tensorflow object and face detection file system paths.
PATH_TO_OBJ_MODEL = obj_config['objModelPath']
PATH_TO_LABEL_MAP = obj_config['labelMapPath']
# If consecutive ZoneMinder image frames are found then skip this many after the first.
CON_IMG_SKIP = obj_config['conseqImagesToSkip']
# Minimum score for valid TF object detection. 
MIN_SCORE_THRESH = obj_config['minScore']
# Heartbeat interval for zerorpc client in ms.
# This must match the zerorpc client config. 
OBJ_ZRPC_HEARTBEAT = obj_config['zerorpcHeartBeat']
# IPC (or TCP) socket for zerorpc.
# This must match the zerorpc client config.
OBJ_ZRPC_PIPE = obj_config['zerorpcPipe']
# Mount point of zm alarms on local tpu machine. 
OBJ_MOUNT_POINT = obj_config['mountPoint']

### Face detection configuration. ###
# Tensorflow face detection model path.
PATH_TO_FACE_DET_MODEL = face_config['faceDetModelPath']
# py torch face embeddings model path (if used).
PATH_TO_FACE_EMB_MODEL = face_config['faceEmbModelPath']
# Heartbeat interval for zerorpc client in ms.
# This must match the zerorpc client config. 
FACE_ZRPC_HEARTBEAT = face_config['zerorpcHeartBeat']
# IPC (or TCP) socket for zerorpc.
# This must match the zerorpc client config.
FACE_ZRPC_PIPE = face_config['zerorpcPipe']
# Mount point of zm alarms on local tpu machine. 
FACE_MOUNT_POINT = obj_config['mountPoint']
# Settings for SVM face classifier.
# The model and label encoder needs to be generated by 'train.py' first. 
SVM_MODEL_PATH = face_config['svmModelPath']
SVM_LABEL_PATH = face_config['svmLabelPath']
MIN_SVM_PROBA = face_config['minSvmProba']
# Images with Variance of Laplacian less than this are declared blurry. 
FOCUS_MEASURE_THRESHOLD = face_config['focusMeasureThreshold']
# Faces with width or height less than this are too small for recognition.
# In pixels.
MIN_FACE = face_config['minFace']
# Number of times to resample for dlib face encoder.
NUM_JITTERS = face_config['numJitters']

def ReadLabelFile(file_path):
    # Function to read labels from text files.
    with open(file_path, 'r') as f:
        lines = f.readlines()
    ret = {}
    for line in lines:
        pair = line.strip().split(maxsplit=1)
        ret[int(pair[0])] = pair[1].strip()
    return ret

# Initialize tpu engines.
obj_engine = DetectionEngine(PATH_TO_OBJ_MODEL)
labels_map = ReadLabelFile(PATH_TO_LABEL_MAP)
face_engine = DetectionEngine(PATH_TO_FACE_DET_MODEL)

# Load svm face recognition model along with the label encoder.
with open(SVM_MODEL_PATH, 'rb') as fp:
    recognizer = pickle.load(fp)
with open(SVM_LABEL_PATH, 'rb') as fp:
    le = pickle.load(fp)

def svm_face_classifier(encoding, min_proba):
    # perform svm classification to recognize the face based on 128D encoding
    # note: reshape(1,-1) converts 1D array into 2D
    preds = recognizer.predict_proba(encoding.reshape(1, -1))[0]
    j = np.argmax(preds)
    proba = preds[j]
    logging.debug('svm proba {} name {}'.format(proba, le.classes_[j]))
    if proba >= min_proba:
        name = le.classes_[j]
        logging.debug('svm says this is {}'.format(name))
    else:
        name = None # prob too low to recog face
        logging.debug('svm cannot recognize face')
    return name

def variance_of_laplacian(image):
    # compute the Laplacian of the image and then return the focus
    # measure, which is simply the variance of the Laplacian
    return cv2.Laplacian(image, cv2.CV_64F).var()

def skip_inference(frame_num, monitor, labels, image_path, objects_in_image):
    """
    If consecutive frames then repeat last label and skip a new inference.
    
    Image paths must be in the form of:
    '/nvr/zoneminder/events/BackPorch/18/06/20/19/20/04/00224-capture.jpg'.
    """
    old_frame_num = frame_num
    old_monitor = monitor
    skip = False
    try:
        frame_num = int((image_path.split('/')[-1]).split('-')[0])
        monitor = image_path.split('/')[4]
    except (ValueError, IndexError):
        logging.error("Could not derive information from image path.")
        objects_in_image.append({'image': image_path, 'labels': []})
        skip = True
        return skip, frame_num, monitor
                    
    # Only apply skip logic if frames are from the same monitor. 
    if monitor == old_monitor:
        # Only apply skip logic if alarm frames are from the same event.
        # Intra-event frames are monotonically increasing.
        frame_diff = frame_num - old_frame_num
        if frame_diff > 0:
            # Skip CON_IMG_SKIP frames after the first one. 
            if frame_diff <= CON_IMG_SKIP:
                objects_in_image.append({'image': image_path, 'labels': labels})
                logging.debug('monitor {} old_monitor {} frame_num {} old_frame_num {}'
                    .format(monitor,old_monitor,frame_num,old_frame_num))
                logging.debug('Consecutive frame {}, skipping detect and copying previous labels.'
                    .format(frame_num))
                skip = True
                        
    return skip, frame_num, monitor

# zerorpc obj det server.
class ObjDetectRPC(object):
    def detect_objects(self, test_image_paths):
        objects_in_image = [] # holds all objects found in image
        labels = [] # labels of detected objects
        frame_num = 0 # ZoneMinder current alarm frame number
        monitor = '' # ZoneMinder current monitor name

        for image_path in test_image_paths:
            logging.debug('**********Find object(s) for {}'.format(image_path))

            # If consecutive frames then repeat last label and skip inference.
            # This behavior controlled by CON_IMG_SKIP.
            skip, frame_num, monitor = skip_inference(frame_num, monitor,
                labels, image_path, objects_in_image)
            if skip is True:
                continue

            # Read image from disk. 
            img = cv2.imread(OBJ_MOUNT_POINT + image_path)
            #cv2.imwrite('./obj_img.jpg', img)
            if img is None:
                # Bad image was read.
                logging.error('Bad image was read.')
                objects_in_image.append({'image': image_path, 'labels': []})
                continue

            # Resize. The tpu obj det requires (300, 300).
            res = cv2.resize(img, dsize=(300, 300), interpolation=cv2.INTER_AREA)
            #cv2.imwrite('./obj_res.jpg', res)

            # Run object inference.
            detection = obj_engine.DetectWithInputTensor(res.reshape(-1),
                threshold=0.1, top_k=3)

            # Get labels and scores of detected objects.
            labels = [] # new detection, clear labels list. 
            (h, w) = img.shape[:2] # use original image size for box coords
            for obj in detection:
                logging.debug('id: {} name: {} score: {}'
                    .format(obj.label_id, labels_map[obj.label_id], obj.score))
                if obj.score > MIN_SCORE_THRESH:
                    object_dict = {}
                    object_dict['id'] = obj.label_id
                    object_dict['name'] = labels_map[obj.label_id]
                    object_dict['score'] = float(obj.score)
                    (xmin, ymin, xmax, ymax) = (obj.bounding_box.flatten().tolist()) * np.array([w, h, w, h])
                    object_dict['box'] = {'ymin': ymin, 'xmin': xmin, 'ymax': ymax, 'xmax': xmax}
                    labels.append(object_dict)

            objects_in_image.append({'image': image_path, 'labels': labels})
        return json.dumps(objects_in_image)

# zerorpc face detection server.
class FaceDetectRPC(object):
    def detect_faces(self, test_image_paths):
        # List that will hold all images with any face detection information. 
        objects_detected_faces = []

        # Loop over the images paths provided. 
        for obj in test_image_paths:
            logging.debug('**********Find Face(s) for {}'.format(obj['image']))
            for label in obj['labels']:
                # If the object detected is a person then try to identify face. 
                if label['name'] == 'person':
                    # Read image from disk. 
                    img = cv2.imread(FACE_MOUNT_POINT + obj['image'])
                    if img is None:
                        # Bad image was read.
                        logging.error('Bad image was read.')
                        label['face'] = None
                        continue

                    # First bound the roi using the coord info passed in.
                    # The roi is area around person(s) detected in image.
                    # (x1, y1) are the top left roi coordinates.
                    # (x2, y2) are the bottom right roi coordinates.
                    y2 = int(label['box']['ymin'])
                    x1 = int(label['box']['xmin'])
                    y1 = int(label['box']['ymax'])
                    x2 = int(label['box']['xmax'])
                    roi = img[y2:y1, x1:x2, :]
                    cv2.imwrite('./roi.jpg', roi)
                    if roi.size == 0:
                        # Bad object roi...move on to next image.
                        logging.error('Bad object roi.')
                        label['face'] = None
                        continue

                    # Need roi shape for later conversion of face coords.
                    (h, w) = roi.shape[:2]
                    # Resize roi for face detection.
                    # The tpu face det model used requires (320, 320).
                    res = cv2.resize(roi, dsize=(320, 320), interpolation=cv2.INTER_AREA)
                    #cv2.imwrite('./res.jpg', res)

                    # Detect the (x, y)-coordinates of the bounding boxes corresponding
                    # to each face in the input image using the TPU engine.
                    # NB: reshape(-1) converts the np img array into 1-d. 
                    detection = face_engine.DetectWithInputTensor(res.reshape(-1),
                        threshold=0.1, top_k=1)
                    if not detection:
                        # No face detected...move on to next image.
                        logging.debug('No face detected.')
                        label['face'] = None
                        continue
                        
                    # Convert coords and carve out face roi.
                    box = (detection[0].bounding_box.flatten().tolist()) * np.array([w, h, w, h])
                    (face_left, face_top, face_right, face_bottom) = box.astype('int')
                    face_roi = roi[face_top:face_bottom, face_left:face_right, :]
                    #cv2.imwrite('./face_roi.jpg', face_roi)
                    (f_h, f_w) = face_roi.shape[:2]
                    # If face width or height are not sufficiently large then skip.
                    if f_h < MIN_FACE or f_w < MIN_FACE:
                        logging.debug('Face too small to recognize.')
                        label['face'] = None
                        continue

                    # Compute the focus measure of the face
                    # using the Variance of Laplacian method.
                    # See https://www.pyimagesearch.com/2015/09/07/blur-detection-with-opencv/
                    gray = cv2.cvtColor(face_roi, cv2.COLOR_BGR2GRAY)
                    fm = variance_of_laplacian(gray)
                    # If fm below a threshold then face probably isn't clear enough
                    # for face recognition to work, so skip it. 
                    if fm < FOCUS_MEASURE_THRESHOLD:
                        logging.debug('Face too blurry to recognize.')
                        label['face'] = None
                        continue

                    # Find the 128-dimension face encoding for face in image.
                    # Convert image roi from BGR (OpenCV ordering) to dlib ordering (RGB).
                    rgb = cv2.cvtColor(roi, cv2.COLOR_BGR2RGB)
                    # Convert face bbox into dlib format.
                    boxes = [(face_top, face_right, face_bottom, face_left)]
                    # Generate encodings. Only one face is assumed so take the 1st element. 
                    encoding = face_recognition.face_encodings(face_image=rgb,
                        known_face_locations=boxes, num_jitters=NUM_JITTERS)[0]

                    # Perform svm classification on the encodings to recognize the face.
                    name = svm_face_classifier(encoding, MIN_SVM_PROBA)

                    # Add face name to label metadata.
                    label['face'] = name
            # Add processed image to output list. 
            objects_detected_faces.append(obj)
        # Convert json to string and return data. 
        return(json.dumps(objects_detected_faces))

# Setup face detection server. 
face_s = zerorpc.Server(FaceDetectRPC(), heartbeat=FACE_ZRPC_HEARTBEAT)
face_s.bind(FACE_ZRPC_PIPE)
# Register graceful ways to stop server. 
gevent.signal(SIGINT, face_s.stop) # Ctrl-C
gevent.signal(SIGTERM, face_s.stop) # termination

# Setup object detection server. 
obj_s = zerorpc.Server(ObjDetectRPC(), heartbeat=OBJ_ZRPC_HEARTBEAT)
obj_s.bind(OBJ_ZRPC_PIPE)
# Register graceful ways to stop server. 
gevent.signal(SIGINT, obj_s.stop) # Ctrl-C
gevent.signal(SIGTERM, obj_s.stop) # termination

# Startup both servers.
# This will block until a gevent SIGINT or SIGTERM signal is caught.
gevent.joinall([gevent.spawn(face_s.run), gevent.spawn(obj_s.run)])